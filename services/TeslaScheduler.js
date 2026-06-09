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
const WEEK_MS      = 7 * 24 * 60 * 60 * 1000;  // opportunistisch hooguit 1×/week
const RECONCILE_MS = 5 * 60 * 1000;    // min. tussen herhaalde bijstuur-commando's
const FAIL_RETRY_MS = 90 * 1000;       // sneller opnieuw na een mislukte sturing (met wake)
const GIVEUP_MS     = 30 * 60 * 1000;  // na opgeven: lang terug (geen wake-credits verbranden)
const MAX_DRIVE_ATTEMPTS = 5;          // na zoveel mislukte pogingen: melden + backoff

class TeslaScheduler {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this._ring = [];
    this._timer = null;
    this._cmdDay = null;
    this._cmdCount = 0;
    this._last = null;             // laatste beslissing (voor getStatus/projectie)
    this._lastSentWant = null;     // laatst gestuurde wens (true=laden, false=stop)
    this._lastSentTs = 0;          // wanneer voor het laatst gestuurd (cooldown)
    this._mismatchStreak = 0;      // opeenvolgende cycli werkelijk≠gewenst (wake-escalatie)
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

  /** Device-id van het PbtH Stroomprijzen-device (actuele uurprijzen). */
  _pricesId() {
    const d = this.homey.settings.get('decisionlog_devices') || {};
    return d.prices || 'cc19fcf6-8f6f-4174-8f9b-6163b630f360';
  }

  /** EpexPredictor-horizon (15-min, all-in) met PbtH-overlay: de eerstvolgende
   *  8 uur krijgen de échte beursprijzen (meter_price_h0..h7) i.p.v. forecast. */
  async _blendedHorizon() {
    const base = (this.app.pricePredictor?.getHorizon() || [])
      .map(h => ({ ...h, t: new Date(h.ts).getTime() }));
    this._lastOverlay = 0;
    if (!base.length) return base;

    const HOUR = 3_600_000;

    // 1) EnergyZero: échte uurprijzen voor heel vandaag + morgen (indien provider).
    try {
      const actual = this.app.pricePredictor?.getActualPrices
        ? await this.app.pricePredictor.getActualPrices() : null;
      if (actual && actual.size) {
        for (const s of base) {
          const hs = Math.floor(s.t / HOUR) * HOUR;
          if (actual.has(hs)) { s.import_eur = actual.get(hs); s.actual = true; this._lastOverlay++; }
        }
        if (this._lastOverlay) return base;   // volledige actuals → klaar
      }
    } catch (_) { /* val terug op PbtH-overlay */ }

    // 2) Fallback: PbtH-overlay van de eerstvolgende 8 uur.
    let pbth = null;
    try {
      const dev  = await this.app.getDevice(this._pricesId());
      const caps = dev?.capabilitiesObj || {};
      pbth = [];
      for (let i = 0; i < 8; i++) {
        const v = caps[`meter_price_h${i}`]?.value;
        pbth.push(v == null ? null : v);
      }
    } catch (_) { pbth = null; }
    if (!pbth || pbth.every(v => v == null)) return base;

    const nowHourStart = Math.floor(Date.now() / HOUR) * HOUR;
    for (const s of base) {
      const off = Math.round((Math.floor(s.t / HOUR) * HOUR - nowHourStart) / HOUR);
      if (off >= 0 && off < 8 && pbth[off] != null) {
        s.import_eur = pbth[off];   // echte all-in uurprijs
        s.actual = true;
        this._lastOverlay++;
      }
    }
    return base;
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

  /** Leest RECHTSTREEKS {charging, limit} (vers, omzeilt adapter-cache). null=onbekend. */
  async _readActual() {
    try {
      const dev = await this.app.getDevice(this._teslaBatId());
      const c = dev?.capabilitiesObj || {};
      const power  = c.measure_charge_power?.value;
      const stateC = c.charging_state?.value;
      let charging = null;
      if (power != null) charging = power > 0.1;             // kW
      else if (stateC != null) charging = String(stateC).toLowerCase() === 'charging';
      const limit = (typeof c.measure_charge_limit_soc?.value === 'number')
        ? c.measure_charge_limit_soc.value : null;
      return { charging, limit };
    } catch (_) { return { charging: null, limit: null }; }
  }

  /** Maakt de auto wakker (best-effort) zodat een volgend commando aankomt. */
  async _wake() {
    try {
      await this.app.runDeviceAction(this._teslaCarId(), 'car_wake_up', { wait: 'wait' });
      this._lastAmps = null; this._lastLimit = null;        // forceer her-sturing van amps/limiet
      this._bumpCmd();
    } catch (e) { this.app.log(`[TeslaSched] wake niet gelukt (${e?.message || e})`); }
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
      this._lastSentWant = null;
      this._mismatchStreak = 0;
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
    // Opportunistisch plafond, hard afgetopt op 85% (bovenkant voor de accu).
    const oppCeiling = Math.min(this.homey.settings.get('ev_opportunistic_soc') ?? 85, 85);
    // Bij actieve override geen opportunistisch extra: plafond = het gekozen doel.
    const ceiling = ov.active ? mandatory : Math.max(mandatory, oppCeiling);

    // Wekelijkse opportunistische top-up: zodra het plafond (≈) bereikt is, 7
    // dagen op slot zodat dit hooguit 1× per week gebeurt.
    if (!ov.active && soc != null && soc >= oppCeiling - 1) {
      const lastOpp = this.homey.settings.get('tesla_opp_last_ts') || 0;
      if ((Date.now() - lastOpp) >= WEEK_MS) this.homey.settings.set('tesla_opp_last_ts', Date.now());
    }

    // 3. Horizon — EpexPredictor-forecast met PbtH-overlay (echte beursprijzen
    //    voor de eerstvolgende 8 uur) er overheen.
    const horizon = (await this._blendedHorizon()).sort((a, b) => a.t - b.t);
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
      // Batterijgezondheid: hoge SoC niet lang vasthouden op de NCA-pack.
      const guard = this.homey.settings.get('ev_battery_health') ?? true;
      const HOLD = 80, MID = 90, MIDWIN_MS = 6 * 3_600_000;   // 6u vóór deadline
      const within  = horizon.filter(h => h.t >= now - SLOT_MIN * 60_000 && h.t <= dlMs);
      const fullWin = horizon.filter(h => h.t >= now - SLOT_MIN * 60_000);

      // kWh per SoC-band tot het (verplichte) doel
      const bandKwh = (lo, hi) => {
        const from = Math.max(soc, lo), to = Math.min(mandatory, hi);
        return to > from ? (to - from) / 100 * cap / EFFICIENCY : 0;
      };

      // Verplichte vulling per band — venster afhankelijk van gezondheid-bewaking:
      //   0–80%  : goedkoopste uren tot deadline
      //   80–90% : alleen ≤6u vóór deadline (guard), anders overal tot deadline
      //   90–100%: pas op het laatste moment vóór deadline (guard), anders goedkoopst
      const mandSet = new Set();
      const addAll = (st) => { st.set.forEach(t => mandSet.add(t)); };
      addAll(this._pickCheapest(within, bandKwh(0, HOLD), slotKwh, mandSet));
      const win8090 = guard ? within.filter(h => h.t >= dlMs - MIDWIN_MS) : within;
      addAll(this._pickCheapest(win8090, bandKwh(HOLD, MID), slotKwh, mandSet));
      addAll(guard
        ? this._pickLatest(within,   bandKwh(MID, 100), slotKwh, mandSet)
        : this._pickCheapest(within, bandKwh(MID, 100), slotKwh, mandSet));

      // Opportunistisch tot plafond (≤85%), hele horizon, excl. verplicht.
      // Hooguit 1× per week: na het bereiken van het plafond 7 dagen op slot.
      const lastOpp   = this.homey.settings.get('tesla_opp_last_ts') || 0;
      const oppLocked = (now - lastOpp) < WEEK_MS;
      const fromOpp   = Math.max(soc, mandatory);
      const need2     = (!oppLocked && soc < ceiling)
        ? Math.max(0, (ceiling - fromOpp) / 100 * cap) / EFFICIENCY : 0;
      const oppSet    = this._pickCheapest(fullWin, need2, slotKwh, mandSet).set;

      kwhNeeded = (soc < mandatory ? (mandatory - soc) / 100 * cap / EFFICIENCY : 0) + need2;
      selectedCount = mandSet.size + oppSet.size;
      const mandLast = mandSet.size ? Math.max(...mandSet) : 0;
      if (mandLast) readyByIso = new Date(mandLast + SLOT_MIN * 60_000).toISOString();
      const unionLast = Math.max(mandLast, oppSet.size ? Math.max(...oppSet) : 0);
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
        const inMand = mandSet.has(cur.t);
        const inOpp  = oppSet.has(cur.t);
        chargeNow = inMand || inOpp;
        tier = inMand ? 'verplicht' : (inOpp ? 'opportunistisch' : null);
        decision = chargeNow ? (inMand ? 'charge_mandatory' : 'charge_opportunistic') : 'wait_cheaper';
        this._healthGuard = guard;
        reason = chargeNow
          ? `${tier} laden (€${currentPrice?.toFixed(3) ?? '?'}) — ${selectedCount} slots${guard ? ', gezondheid-bewaakt' : ''} @ ${effRate.toFixed(1)}kW`
          : `nu €${currentPrice?.toFixed(3) ?? '?'} — wacht (doel ${mandatory}% ~${readyByIso ? this.app.localTime(new Date(readyByIso)) : '?'}, plafond ${ceiling}% ~${ceilReadyIso ? this.app.localTime(new Date(ceilReadyIso)) : '?'})`;
      }
    }

    // 4. Reconciliatie: stuur tot de WERKELIJKE laadstatus de gewenste volgt.
    //    Niet alleen op onze eigen toestand-wissel, maar elke cyclus vergelijken —
    //    zo wordt een auto die uit zichzelf doorlaadt/herstart (of op doel niet
    //    stopt omdat de auto-limiet hoger staat) alsnog bijgestuurd.
    const live = this._isLive();
    let commanded = null, verify = null;
    if (connected && soc != null) {
      const want = chargeNow;                          // false bij wait/at_target, true bij laden/panic
      const { charging: actual, limit: carLimit } = await this._readActual();

      // Wil laden, maar de auto staat op z'n eigen laadlimiet → kan niet hoger.
      // Verhoog die best-effort richting het plafond; geen start/wake-spam.
      const atCarLimit = want && actual === false && carLimit != null && soc >= carLimit;

      const mismatch    = atCarLimit ? false
        : (actual === null) ? (this._lastSentWant !== want) : (actual !== want);
      const wishChanged = this._lastSentWant !== want;
      const lastFailed  = !!this._lastDriveError;      // vorige sturing mislukte (bv. could_not_wake_buses)
      const streak      = this._mismatchStreak || 0;
      const givenUp     = streak >= MAX_DRIVE_ATTEMPTS;
      const sinceLast   = Date.now() - (this._lastSentTs || 0);
      // Ritme: normaal 5 min; na een mislukte sturing sneller (90s) om te wekken;
      // na opgeven lang terug (30 min) zodat we geen wake-credits blijven verbranden.
      const interval    = givenUp ? GIVEUP_MS : (lastFailed ? FAIL_RETRY_MS : RECONCILE_MS);
      const due         = wishChanged || sinceLast >= interval;

      if (atCarLimit) {
        // Op auto-eigen limiet: probeer 'm best-effort te verhogen richting plafond.
        this._mismatchStreak = 0;
        if (live && ceiling > carLimit && (Date.now() - (this._lastLimitTry || 0)) >= RECONCILE_MS) {
          await this._tryAction(this._teslaBatId(), 'charge_limit', { limit: Math.min(100, Math.max(50, Math.round(ceiling))) });
          this._lastLimitTry = Date.now();
          this._bumpCmd();
        }
        verify = `auto-limiet ${carLimit}%`;
      } else if (mismatch && due) {
        this._mismatchStreak = wishChanged ? 1 : streak + 1;
        commanded = want ? 'start' : 'stop';
        if (live) {
          // Wakker maken als de auto het commando-bus niet kon wekken, of bij
          // herhaalde mismatch — maar niet meer na opgeven (credit-bescherming).
          const needWake = actual !== null && !givenUp &&
            (lastFailed || this._mismatchStreak >= 2);
          if (needWake) { await this._wake(); verify = `wake#${this._mismatchStreak}`; }
          const ok = await this._drive(tesla, want, maxA, ceiling);
          if (!ok) commanded = null;
          if (this._mismatchStreak === MAX_DRIVE_ATTEMPTS) {
            this.app.notifications?.send(
              `⚠️ Tesla volgt het ${want ? 'start' : 'stop'}-commando niet (${this._lastDriveError || '?'}). Ik probeer het minder vaak; controleer de auto/Tesla-app.`
            );
          }
        }
        this._lastSentWant = want;
        this._lastSentTs   = Date.now();
        this._bumpCmd();
        if (!verify) verify = `stuur#${this._mismatchStreak}`;
      } else if (!mismatch) {
        this._mismatchStreak = 0;
        this._lastDriveError = null;
        if (actual !== null) verify = 'ok';            // werkelijk == gewenst
      }
    } else {
      this._lastSentWant = null;
      this._mismatchStreak = 0;
    }

    // 5. Record
    const rec = {
      ts: new Date().toISOString(),
      ts_local: this.app.localTime(),
      mode: live ? 'live' : 'dryrun',
      connected, soc, target_pct: mandatory, ceiling_pct: ceiling, tier,
      health_guard: (this.homey.settings.get('ev_battery_health') ?? true),
      deadline_local: this.app.localTime(deadline),
      override_active: ov.active,
      decision, reason, charge_now: chargeNow,
      kwh_needed: +kwhNeeded.toFixed(2),
      power_kw: +powerKw.toFixed(2),
      eff_rate_kw: +effRate.toFixed(2),
      selected_slots: selectedCount,
      actual_overlay_slots: this._lastOverlay ?? 0,
      current_price_eur: currentPrice,
      ready_by_local: readyByIso ? this.app.localTime(new Date(readyByIso)) : null,
      ceil_ready_local: ceilReadyIso ? this.app.localTime(new Date(ceilReadyIso)) : null,
      commanded, verify, drive_error: this._lastDriveError || null, cmd_count_today: this._cmdCount,
    };
    this._last = {
      decision, reason, charge_now: chargeNow, tier,
      connected, soc,
      target_pct: mandatory, ceiling_pct: ceiling,
      kwh_needed: rec.kwh_needed, ready_by_iso: readyByIso,
      ready_by_local: rec.ready_by_local, ceil_ready_local: rec.ceil_ready_local,
      mode: rec.mode, current_price_eur: currentPrice,
      updated_local: rec.ts_local,
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

  /** Laatste slots vóór de deadline (voor de 90–100%-band: 'pas op het laatste
   *  moment laden'). Kiest chronologisch van achteren, ongeacht prijs. */
  _pickLatest(slots, kwhNeeded, slotKwh, excludeSet) {
    const set = new Set();
    let count = 0, acc = 0, lastTs = null;
    if (kwhNeeded <= 0 || slotKwh <= 0) return { set, count, lastTs };
    const sorted = slots
      .filter(s => !excludeSet || !excludeSet.has(s.t))
      .sort((a, b) => b.t - a.t);              // nieuwste (dichtst bij deadline) eerst
    for (const s of sorted) {
      if (acc >= kwhNeeded) break;
      set.add(s.t); acc += slotKwh; count++;
    }
    if (set.size) lastTs = Math.max(...set);
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
      // Hoofdsturing: start/stop via de settable capability `charging_on`
      // (betrouwbaar — flow-acties botsten op "Missing Scopes").
      await this.app.setDeviceCapability(dev, 'charging_on', !!wantCharge);

      // Laadlimiet + amps zijn best-effort via de flow-acties: mogen falen zonder
      // de hoofdsturing (start/stop) te blokkeren. Alleen bij (her)wijziging.
      if (wantCharge) {
        const limit = Math.max(50, Math.min(100, Math.round(targetPct)));
        if (this._lastLimit !== limit) { if (await this._tryAction(dev, 'charge_limit', { limit })) this._lastLimit = limit; }
        const amps = Math.max(1, Math.min(32, Math.round(maxA)));
        if (this._lastAmps !== amps) { if (await this._tryAction(dev, 'charge_current', { current: amps })) this._lastAmps = amps; }
      }
      this._lastDriveError = null;
      return true;
    } catch (err) {
      this._lastDriveError = err?.message || String(err);
      this.app.error('[TeslaSched] sturing-fout:', this._lastDriveError);
      return false;
    }
  }

  /** Best-effort flow-actie; faalt stil (logt) zonder de hoofdsturing te raken. */
  async _tryAction(dev, card, args) {
    try { await this.app.runDeviceAction(dev, card, args); return true; }
    catch (e) { this.app.log(`[TeslaSched] ${card} niet gezet (${e?.message || e})`); return false; }
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
