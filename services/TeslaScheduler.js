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
const VERIFY_MS    = 60 * 1000;        // na een nog-niet-bevestigd commando: ~1 min later opnieuw kijken
const GIVEUP_MS     = 30 * 60 * 1000;  // na opgeven: lang terug (geen wake-credits verbranden)
const MAX_DRIVE_ATTEMPTS = 5;          // na zoveel mislukte pogingen: melden + backoff
const WAKE_WAIT_MS = 30 * 1000;        // max wachten tot de auto 'online' is ná een wake-commando
const WAKE_POLL_MS = 3 * 1000;         // poll-interval van car_state tijdens dat wachten

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
    this._session = null;          // lopende laadsessie (voor lerend tijd/temp-model, fase A)
  }

  async init() {
    try { fs.mkdirSync(USERDATA_DIR, { recursive: true }); } catch (_) {}
    this._tickSafe();
    this._timer = this.homey.setInterval(() => this._tickSafe(), PERIOD_MS);
    this.app.log(`[TeslaSched] actief — prijs-gestuurd, ${this._mode()} | cyclus ${PERIOD_MS / 1000}s`);
    this._subscribeEvents();   // push: reageer direct op laden-start/stop i.p.v. wachten op de tick
  }

  /**
   * Abonneer op capability-wijzigingen van het Tesla-batterij-device (push). De com.tesla-app
   * vuurt deze realtime zodra hij de cloud-status bijwerkt — sneller dan onze 60s-tick en
   * zonder cache-vertraging. Bij elke relevante wijziging draaien we meteen een tick, zodat
   * een zelf-gestarte laadsessie binnen seconden herkend en (indien nodig) gestopt wordt.
   * De 60s-tick blijft als vangnet als de realtime-verbinding wegvalt.
   */
  async _subscribeEvents() {
    const caps = ['charging_on', 'charging_state', 'measure_charge_power', 'charging_port', 'charging_port_cable'];
    try {
      const dev = await this.app.getDevice(this._teslaBatId());
      this._capInstances = [];
      for (const cap of caps) {
        if (!dev.capabilities?.includes(cap)) continue;
        const inst = dev.makeCapabilityInstance(cap, (value) => {
          this.app.log(`[TeslaSched] event ${cap}=${value} → directe tick`);
          this._tickSafe();
        });
        this._capInstances.push(inst);
      }
      this.app.log(`[TeslaSched] push-abonnement actief op ${this._capInstances.length} capabilities`);
    } catch (e) {
      this.app.error('[TeslaSched] push-abonnement mislukt (val terug op 60s-tick):', e?.message || e);
    }
  }

  destroy() {
    if (this._timer) this.homey.clearInterval(this._timer);
    for (const inst of this._capInstances || []) { try { inst.destroy(); } catch (_) {} }
  }

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

  /**
   * Leest {charging, limit, dc, powerKw}. null=onbekend.
   *
   * `charging` = wat de TESLA ZELF meldt (charging_on / charging_state). Dat is hét bewijs
   * van laden; de vermogensmeting (measure_charge_power) is daarvoor NIET leidend — die kan
   * stale zijn (gezien: 3 kW blijven hangen ná de stop → zou een onnodige wake triggeren).
   * `powerKw` houden we alleen ter info in de log. charging_on kan een paar minuten achterlopen,
   * maar dat valt binnen de geaccepteerde reactietijd (≈10 min).
   * `dc`=true bij DC-snelladen (Supercharger) → onderweg → niet sturen (home-gate).
   * De charge-limiet (charge_limit_soc) komt van het batterij-device (auto-config).
   */
  async _readActual(st = null) {
    let charging = null;
    let limit = null;
    let dc = false;
    let powerKw = null;
    let noPower = false;
    let chargeAdded = null;
    try {
      const dev = await this.app.getDevice(this._teslaBatId());
      const c = dev?.capabilitiesObj || {};
      const p = c.measure_charge_power?.value;
      powerKw = (typeof p === 'number') ? p : null;
      // Sessie-laadenergie aan de batterij (DC, ná laadverlies) — grondwaarheid voor de
      // EV-boeking; reset naar 0 bij een nieuwe sessie. Veel betrouwbaarder dan measure_charge_power
      // (die meldt vaak 0 terwijl charging_on=true). Zie EnergyLedger + ev-charger-device.
      if (typeof c.measure_charge_energy_added?.value === 'number') chargeAdded = c.measure_charge_energy_added.value;
      if (typeof c.measure_charge_limit_soc?.value === 'number') limit = c.measure_charge_limit_soc.value;
      if ((c.measure_charge_power_dc?.value ?? 0) > 0.1) dc = true;   // DC-vermogen alleen voor onderweg-detectie
      const stateText = c.charging_state?.value != null ? String(c.charging_state.value).toLowerCase() : null;
      // De Tesla-boolean is leidend: charging_on (via adapter st) of charging_state='Charging'.
      if ((st && st.charging === true) || stateText === 'charging') charging = true;
      else if ((st && st.connected) || stateText != null) charging = false;
      // 'NoPower' = kabel ingeplugd maar GEEN stroom op de kabel (laadpunt uit → rode kabel),
      // i.t.t. 'Stopped' (stroom beschikbaar, gepauzeerd → blauwe kabel). Starten is dan zinloos.
      noPower = stateText ? stateText.replace(/\s/g, '') === 'nopower' : false;
    } catch (_) { /* velden blijven null */ }
    return { charging, limit, dc, powerKw, noPower, chargeAdded };
  }

  /**
   * Boekt EV-laadenergie betrouwbaar uit `measure_charge_energy_added` (sessie-DC, reset per
   * sessie) en houdt één monotone cumulatieve AC-teller bij (= de netafname voor het laden):
   * AC = DC ÷ laadefficiëntie. Dit is dé bron van waarheid voor zowel de EnergyLedger
   * (huishouden = verbruik − EV) als het ev-charger-device (Homey Energy). Vervangt de oude
   * integratie van `charge_power_kw`, die vaak 0 meldde tijdens laden → EV werd nooit geboekt.
   */
  _trackEvEnergy(addedDc) {
    if (typeof addedDc !== 'number' || addedDc < 0) return;
    if (this._evTotalAcKwh == null) this._evTotalAcKwh = this.homey.settings.get('tesla_ev_energy_ac_kwh') || 0;
    if (this._evLastAddedDc == null) {
      const persisted = this.homey.settings.get('tesla_ev_last_added_dc');
      this._evLastAddedDc = (typeof persisted === 'number') ? persisted : addedDc;   // 1e read = baseline
    }
    const prev = this._evLastAddedDc;
    const deltaDc = addedDc >= prev ? (addedDc - prev) : addedDc;   // dalend = nieuwe sessie (reset naar ~0)
    this._evLastAddedDc = addedDc;
    this.homey.settings.set('tesla_ev_last_added_dc', addedDc);
    if (deltaDc > 0) {
      const eff = Math.min(1, Math.max(0.5, this.homey.settings.get('ev_charge_efficiency') ?? 0.90));
      this._evTotalAcKwh += deltaDc / eff;
      this.homey.settings.set('tesla_ev_energy_ac_kwh', this._evTotalAcKwh);
    }
  }

  /** Maakt de auto wakker (best-effort) zodat een volgend commando aankomt. */
  _sleep(ms) { return new Promise((r) => this.homey.setTimeout(r, ms)); }

  /**
   * Wekt de auto en WACHT tot hij echt 'online' is (car_state op het AUTO-device) vóór we
   * een commando sturen — anders landt het laad-commando op een nog-slapende auto en geeft
   * `could_not_wake_buses`, met een onnodige tweede wake op de volgende tick tot gevolg.
   * Logt hoe lang het wekken duurde (zichtbaar in rec.wake_secs en de app-log).
   * @returns {boolean} of de auto binnen de timeout online kwam.
   */
  async _wake() {
    const t0 = Date.now();
    // Wekken via de SETTABLE capability `car_wake_up` (boolean), NIET via de flow-actie:
    // flow-acties van een ander app-device vereisen de `homey.flow`-scope, die een app niet
    // krijgt ("Missing Scopes") — settable capabilities (homey.device.control) wél. Zie de
    // limiet-discussie: alleen settable caps zijn programmatisch te zetten.
    try {
      await this.app.setDeviceCapability(this._teslaCarId(), 'car_wake_up', true);
    } catch (e) { this.app.log(`[TeslaSched] wake-commando faalde (${e?.message || e})`); }
    this._bumpCmd();
    let cs = await this._carState();
    while (cs !== 'online' && (Date.now() - t0) < WAKE_WAIT_MS) {
      await this._sleep(WAKE_POLL_MS);
      cs = await this._carState();
    }
    const secs = +((Date.now() - t0) / 1000).toFixed(1);
    const online = cs === 'online';
    this._lastWakeSecs = secs; this._lastWakeOnline = online;
    if (online) this._ewmaSet('tesla_learn_wake_secs', secs, 0.3, 0, 120, 1);   // fase A: leer wektijd
    this._lastAmps = null; this._lastLimit = null;          // forceer her-sturing van amps/limiet
    this.app.log(`[TeslaSched] wake → car_state=${cs} na ${secs}s (online=${online})`);
    return online;
  }

  async _tickSafe() {
    if (this._ticking) return;       // re-entry-guard: _wake() kan een tick ~30s blokkeren
    this._ticking = true;
    try { await this._tick(); }
    catch (err) { this.app.error('[TeslaSched] fout:', err.message); }
    finally { this._ticking = false; }
  }

  async _tick() {
    const tesla = this.app.ems?.tesla;
    if (!tesla) return;

    // Wij beheren de auto in modus 'price' (prijs, dynamisch contract) of
    // 'surplus' (zonne-overschot, export vermijden). Anders niets doen.
    const chargeMode = this.homey.settings.get('ev_charge_mode') || 'solar_only';
    const contract   = this.homey.settings.get('contract_type') || 'fixed';

    if (chargeMode === 'surplus') {
      const st0 = await tesla.getState();
      return this._tickCombi(tesla, st0);
    }

    // Prijs-scheduler vereist laadmodus 'price' ÉN een dynamisch contract.
    if (chargeMode !== 'price' || contract !== 'dynamic') {
      this._lastSentWant = null;
      this._mismatchStreak = 0;
      const why = chargeMode !== 'price'
        ? `laadmodus '${chargeMode}'`
        : 'vast tarief (geen uurprijzen)';
      // Ook al stuurt de scheduler niet: lees verbinding/laadstroom zodat de widget
      // toont of de auto aangekoppeld is en er stroom loopt (anders lijkt status leeg).
      let connected, soc = null, charging = null;
      try {
        const st = await tesla.getState();
        connected = st?.connected ?? false;
        soc = st?.soc ?? null;
        charging = (await this._readActual(st)).charging;
      } catch (_) { connected = undefined; }
      this._last = {
        decision: 'inactive', mode: this._mode(), charge_now: false,
        connected, soc, charging_actual: charging,
        reason: `${why} — prijs-scheduler inactief`,
      };
      return;
    }

    const { maxA, phases, cap, floor, powerKw } = this._params();

    // 1. Auto-toestand
    const st = await tesla.getState();
    const connected = st?.connected ?? false;
    const soc       = st?.soc ?? null;

    // Laadsnelheid-observer + lerend tijd/temp-model (fase A): meet %/uur (globaal + per
    // temp-bucket), leer overhead, log sessies. Fase C: de beslissingen GEBRUIKEN nu de
    // geleerde, temp-afhankelijke snelheid (val terug op globaal/berekend bij weinig data).
    await this._learn(st, cap);
    const effRate = this._effectiveRateKw(powerKw, this._lastModuleTemp);   // kW (temp-bewust)
    const slotKwh = effRate * SLOT_H;

    // 2. Override of standaard-doel + opportunistisch plafond.
    //    Verre deadline (buiten 168u) → vakantie-hold: behandel als standaard-doel
    //    tot de deadline het venster binnenkomt (ARCHITECTURE v5.7).
    const ov = await this.app.getTeslaOverride();
    const effActive  = ov.active && !ov.far_deadline;
    const vacationSoc = this.homey.settings.get('ev_vacation_soc') ?? 55;   // accu-vriendelijke rust
    // Verre deadline → bewaarstand op vacationSoc; anders standaard-doel.
    const mandatory  = effActive ? ov.target_pct : (ov.far_deadline ? vacationSoc : ov.auto_target_pct);
    // Bewaarstand-venster: bereik de bewaarstand in de goedkoopste uren binnen een ROLLEND
    // venster (default 24u, `ev_hold_horizon_h`) i.p.v. de verre datum/07:00 — zo staat de auto
    // niet dagenlang onder de bewaarstand maar wordt 'ie binnen ~24u goedkoop bijgeladen.
    const holdHorizonMs = (this.homey.settings.get('ev_hold_horizon_h') ?? 24) * 3_600_000;
    const deadline   = new Date(
      effActive          ? ov.deadline_iso
      : ov.far_deadline  ? (Date.now() + holdHorizonMs)
      :                    ov.auto_deadline
    );
    // Opportunistisch plafond, hard afgetopt op 85% (bovenkant voor de accu).
    const oppCeiling = Math.min(this.homey.settings.get('ev_opportunistic_soc') ?? 85, 85);
    // Override of vakantie-hold: geen opportunistisch extra (auto staat dan lang
    // stil → niet naar 85 vullen). Alleen normaal dagelijks gebruik krijgt de top-up.
    const ceiling = (effActive || ov.far_deadline) ? mandatory : Math.max(mandatory, oppCeiling);

    // Wekelijkse opportunistische top-up: zodra het plafond (≈) bereikt is, 7
    // dagen op slot zodat dit hooguit 1× per week gebeurt.
    if (!effActive && soc != null && soc >= oppCeiling - 1) {
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
    let nextChargeIso = null;  // eerstvolgend gepland laadmoment
    let selectedCount = 0;
    let tier = null;
    let actualCharging = null;   // echte laadstroom (true/false/null=onbekend)
    let carLimitRead = null;     // door de auto gerapporteerde laadlimiet (%)
    let awayDc = false;          // DC-snelladen → onderweg → niet sturen
    let chargePowerKw = null;    // gemeten laadvermogen (kW) — grondwaarheid voor laden
    let carStateRead = null;     // car_state van het auto-device (online/asleep/…)
    let wakeSecs = null;         // hoe lang het wekken duurde, indien deze tick gewekt
    let noPowerOnCable = false;  // kabel ingeplugd maar geen stroom (laadpunt uit / rode kabel)

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
      // 0–80%-band: aaneengesloten-bewust (fase B) — doorladen waar het loont, splitsen
      // alleen als de prijsbesparing > C_session. Banden 80-90/90-100 blijven deadline-gestuurd.
      const sessionEur = this.homey.settings.get('ev_session_cost_eur') ?? 0.10;
      // Overhead (ramp) als extra energie bij de hoofd-vulling, zodat het blok ~1 slot
      // langer is en de auto echt op doel komt (fase C). Alleen als er iets te laden valt.
      const band0 = bandKwh(0, HOLD);
      const overheadKwh = band0 > 0 ? (this._overheadMin() / 60) * effRate : 0;
      addAll(this._pickContiguousOptimal(within, band0 + overheadKwh, slotKwh, mandSet, sessionEur));
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
      // Eerstvolgend gepland laadmoment = vroegste gekozen slot vanaf nu.
      const future = [...mandSet, ...oppSet].filter(t => t >= now - SLOT_MIN * 60_000);
      if (future.length) nextChargeIso = new Date(Math.min(...future)).toISOString();

      if (kwhNeeded <= 0) {
        // Niets te laden: boven het doel, en opportunistisch al gehaald/op slot.
        chargeNow = false;
        decision = 'idle';
        const opp = (now - (this.homey.settings.get('tesla_opp_last_ts') || 0)) < WEEK_MS;
        reason = `SoC ${soc}% boven doel ${mandatory}% — niets gepland${opp ? ' (opportunistisch deze week gehaald)' : ''}`;
      } else if (now > dlMs && soc < mandatory) {
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

    // 4. Sturing — PRIMAIR via de laadlimiet ("laad tot X%"): de auto stopt dan
    //    zelf op ons doel, ook terwijl hij (slapend) doorlaadt. Start/stop alleen
    //    voor de timing (laden in goedkope uren), best-effort.
    const live = this._isLive();
    let commanded = null, verify = null;
    if (connected && soc != null) {
      const want = chargeNow;
      const { charging: actual, limit: carLimit, dc, powerKw, noPower, chargeAdded } = await this._readActual(st);
      actualCharging = actual;        // de Tesla-boolean is leidend (charging_on/charging_state)
      carLimitRead = carLimit;
      awayDc = dc;
      chargePowerKw = powerKw;
      noPowerOnCable = noPower;
      this._trackEvEnergy(chargeAdded);   // EV-energie betrouwbaar boeken (één bron voor ledger + device)
      if (!noPower) {
        if (this._noPowerNotified) this.homey.emit('ems:evPowerRestored');  // stroom terug op de kabel
        this._noPowerNotified = false;   // reset zodra er weer stroom op de kabel staat
      }
      // Home-gate: alleen sturen als de auto THUIS is. DC-snelladen = Supercharger =
      // onderweg → handen af, zodat onderweg-laden tot gekozen waardes blijft werken
      // (overbruggen kan altijd via geplande lading in de Tesla-app). AC = thuis.
      const atHome = !dc;
      carStateRead = await this._carState();   // online/asleep — gratis read van het auto-device

      // 4-pre. Wake-ANTICIPATIE (fase D): komt er een laadslot aan terwijl de auto slaapt?
      // Wek 'm dan ~wektijd vóór de slotgrens, zodat het laden direct op tijd begint i.p.v.
      // pas nadat com.tesla 'online' oppikt (asleep-poll kan ~10 min duren). Hooguit 1× per
      // gepland slot; vervangt de reactieve wake (zelfde aantal credits, betere timing).
      if (live && atHome && !want && nextChargeIso && carStateRead && carStateRead !== 'online') {
        const startMs = new Date(nextChargeIso).getTime();
        const leadMs = this._wakeLeadSec() * 1000 + 60_000;   // wektijd + 1 poll-cyclus marge
        const dt = startMs - Date.now();
        if (dt > 0 && dt <= leadMs && this._preWokenForTs !== startMs) {
          this._preWokenForTs = startMs;
          await this._wake(); wakeSecs = this._lastWakeSecs;
          verify = `pre-wake (${wakeSecs}s)`;
        }
      }

      // capPct = het doel-SoC voor deze planning: verplicht/wachten → mandatory · opportunistisch
      // venster → ceiling. In de far-deadline-case is `mandatory` de bewaarstand (55); binnen de week
      // = jouw target. De auto stopt zichzelf op de limiet, dus de limiet = dit doel.
      const capPct = Math.max(50, Math.min(100, Math.round(
        (want && tier === 'opportunistisch') ? ceiling : mandatory
      )));
      const limitTarget = capPct;

      // 4a. Laadlimiet synchroniseren zodra die afwijkt — onafhankelijk van laden/niet-laden, want
      //     het zetten van een limiet lokt zélf geen laden uit (dat doet charging_on). Alleen thuis;
      //     onderweg (DC) de limiet nooit aanraken. Via de trigger-brug `ems:setEvChargeLimit` →
      //     de gebruiker koppelt die aan de Tesla-actie "Stel Laadlimiet SoC in" (een app mag de
      //     flow-actie niet zelf draaien: "Missing Scopes"). RECONCILE-gate tegen herhaald vuren.
      if (live && atHome && carLimit != null && carLimit !== limitTarget &&
          (Date.now() - (this._lastLimitTry || 0)) >= RECONCILE_MS) {
        this.homey.emit('ems:setEvChargeLimit', limitTarget);
        this._lastLimit = limitTarget; this._lastLimitTry = Date.now();
        this._bumpCmd(); verify = `limiet→${limitTarget}%`;
      }

      // 4b. Start/stop voor timing. Twee gevallen:
      //   • ONDER het doel → laad ALLEEN in de gekozen goedkoopste slots (`want`/chargeNow); buiten
      //     die slots niet (bij inplug in een duur uur dus: STOP wat de Tesla zelf startte, wachten).
      //   • OP het doel (binnen ~1% = `reached`) → laden AAN laten ("rust"): de auto pauzeert/hervat
      //     zichzelf op de limiet (slaapt, minimale drain). We sturen dan geen stop, en geen herhaalde
      //     start (zie `carMaintaining`). Boven het doel heeft starten geen zin.
      const reached     = soc >= capPct - 1;
      const want2       = reached || (soc < capPct && want);
      // Status-label: op niveau en geen actief laad-slot → "rust" (laden aan, auto regelt zelf).
      if (reached && !want) {
        decision = 'rust';
        reason = `op niveau ${soc}% (limiet ${capPct}%) — laden aan, Tesla houdt het zelf bij`;
      }
      // De auto reguleert zichzelf op de limiet (zelf-pauze bij bereiken = `actual:false`): dat is
      // GEEN mismatch om te corrigeren. Eén keer inschakelen (eerste start), daarna met rust laten.
      const carMaintaining = want2 && actual === false && reached && this._lastSentWant === true;
      const mismatch    = carMaintaining ? false
                        : (actual === null) ? (this._lastSentWant !== want2) : (actual !== want2);
      const wishChanged = this._lastSentWant !== want2;
      const lastFailed  = !!this._lastDriveError;      // vorige sturing mislukte (could_not_wake_buses)
      const streak      = this._mismatchStreak || 0;
      const givenUp     = streak >= MAX_DRIVE_ATTEMPTS;
      // Hebben we al ≥1 commando gestuurd maar volgt de auto nog niet (streak≥1)? Dan is
      // dit een nog-niet-bevestigde stop/start → ~1 min later opnieuw kijken (i.p.v. 5 min),
      // zodat de wake-then-stop-escalatie (needWake bij streak≥2) snel aanslaat. "Eerst
      // zacht (geen wake), ~1 min later kijken, dan wake + hard stoppen."
      const unconfirmed = streak >= 1;
      const interval    = givenUp ? GIVEUP_MS
                        : lastFailed  ? FAIL_RETRY_MS
                        : unconfirmed ? VERIFY_MS
                        : RECONCILE_MS;
      const due         = wishChanged || (Date.now() - (this._lastSentTs || 0)) >= interval;

      if (!atHome) {
        // Onderweg (DC-snelladen): niet sturen; laat de auto/gebruiker het regelen.
        this._lastSentWant = null; this._mismatchStreak = 0;
        if (!verify) verify = 'onderweg (DC) — niet sturen';
      } else if (noPowerOnCable && want2) {
        // Kabel ingeplugd maar geen stroom (laadpunt uit / rode kabel): starten is zinloos
        // (kost alleen commando's/wakes). Niet sturen; gebruiker éénmalig waarschuwen.
        this._lastSentWant = null; this._mismatchStreak = 0;
        verify = 'geen stroom op kabel (laadpunt uit?)';
        if (!this._noPowerNotified) {
          this._noPowerNotified = true;
          this.app.notifications?.send(
            '🔌 Tesla is aangekoppeld maar er staat geen stroom op de kabel (laadpunt uit / rode kabel). Zet het laadpunt aan zodat ik kan laden.',
            'tesla'
          );
          this.homey.emit('ems:evNoPower');   // flow-trigger "geen stroom op kabel"
        }
      } else if (mismatch && due) {
        this._mismatchStreak = wishChanged ? 1 : streak + 1;
        commanded = want2 ? 'start' : 'stop';
        if (live) {
          // Wakker maken (wake=20 cr) wanneer nodig, niet na opgeven:
          //  • bij een START van een NIET-online auto meteen op de 1e poging — een zachte
          //    start landt toch niet op een slapende auto (could_not_wake_buses) en kost
          //    alleen tijd + een extra wake later;
          //  • anders pas bij herhaalde mismatch / na een mislukte sturing.
          const startAsleep = want2 && carStateRead != null && carStateRead !== 'online';
          const needWake = actual !== null && !givenUp &&
                           (lastFailed || this._mismatchStreak >= 2 || startAsleep);
          if (needWake) { await this._wake(); wakeSecs = this._lastWakeSecs; verify = `wake#${this._mismatchStreak} (${wakeSecs}s)`; }
          const ok = await this._drive(want2, limitTarget);
          if (!ok) commanded = null;
          if (this._mismatchStreak === MAX_DRIVE_ATTEMPTS) {
            this.app.notifications?.send(
              `⚠️ Tesla volgt het ${want2 ? 'start' : 'stop'}-commando niet (${this._lastDriveError || '?'}). Ik probeer het minder vaak; controleer de auto/Tesla-app.`,
              'tesla'
            );
          }
        }
        this._lastSentWant = want2;
        this._lastSentTs   = Date.now();
        this._bumpCmd();
        if (!verify) verify = `stuur#${this._mismatchStreak}`;
      } else if (!mismatch) {
        this._mismatchStreak = 0;
        this._lastDriveError = null;
        if (!verify && actual !== null) verify = `ok(limiet ${carLimit ?? '?'}%)`;
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
      charging_actual: actualCharging, car_limit: carLimitRead, away_dc: awayDc,
      charge_power_kw: chargePowerKw, car_state: carStateRead, wake_secs: wakeSecs,
      no_power: noPowerOnCable,
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
      next_charge_local: nextChargeIso ? this.app.localTime(new Date(nextChargeIso)) : null,
      commanded, verify, drive_error: this._lastDriveError || null, cmd_count_today: this._cmdCount,
    };
    this._last = {
      decision, reason, charge_now: chargeNow, tier,
      connected, soc, charging_actual: actualCharging, no_power: noPowerOnCable,
      away_dc: awayDc, charge_power_kw: chargePowerKw,
      ev_energy_ac_kwh: this._evTotalAcKwh ?? 0,
      target_pct: mandatory, ceiling_pct: ceiling,
      kwh_needed: rec.kwh_needed, ready_by_iso: readyByIso,
      ready_by_local: rec.ready_by_local, ceil_ready_local: rec.ceil_ready_local,
      next_charge_local: rec.next_charge_local,
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

  // ─── Surplus-modus: amps moduleren om teruglevering te vermijden ────────────
  // Behoudend (wear-bescherming auto/laadpaal): starten alleen op AANHOUDEND
  // overschot, ruime min-aan/min-uit-tijden, geen flapperen. Cost-bewust: de
  // amp-aanpassingen zijn verwaarloosbaar; alleen STARTEN wekt (≈2 ct) als de
  // auto slaapt — en dat doen we enkel bij aanhoudend overschot. Hergebruikt
  // Menno's zon-instellingen. Alleen waardevol post-saldering (export ≪ import).
  async _tickCombi(tesla, st) {
    const live = this._isLive();
    const s = this.homey.settings;
    const cfg = this.app.ems?.config?.ev || {};
    const phases  = s.get('ev_phases') ?? cfg.phases ?? 3;
    const minA    = s.get('ev_min_current_a') ?? 6;
    const maxA    = s.get('ev_max_current_a') ?? cfg.maxAmps ?? 16;
    const buffer  = s.get('ev_target_import_w') ?? 100;            // netbuffer (W)
    const startMin = s.get('ev_start_delay_ticks') ?? 3;          // min aanhoudend (min)
    const stopMin  = s.get('ev_stop_delay_ticks') ?? 3;
    const minOnMs  = (s.get('ev_min_on_min') ?? 10) * 60_000;
    const minOffMs = (s.get('ev_min_off_min') ?? 15) * 60_000;
    const floor   = s.get('ev_floor_soc') ?? 20;
    const capKwh  = this._params().cap;
    const V = 230, now = Date.now();

    const connected = st?.connected ?? false;
    const soc = st?.soc ?? null;

    // Doelen: verplicht doel + deadline. Verre deadline → vakantie-hold (val terug
    // op standaard-doel tot de deadline het venster binnenkomt; ARCHITECTURE v5.7).
    const ov = await this.app.getTeslaOverride();
    const effActive = ov.active && !ov.far_deadline;
    const vacationSoc = s.get('ev_vacation_soc') ?? 55;
    const mandatory = effActive ? ov.target_pct : (ov.far_deadline ? vacationSoc : ov.auto_target_pct);
    const dlMs = new Date(effActive ? ov.deadline_iso : ov.auto_deadline).getTime();
    // Vakantie-hold: geen overschot-top-up boven het hold-niveau.
    const ceiling = (effActive || ov.far_deadline) ? mandatory : Math.min(s.get('ev_opportunistic_soc') ?? 85, 100);

    // Overschot nu (zero-export): beschikbaar = huidig EV-vermogen − grid − buffer.
    const grid   = await this._readGridW();
    const teslaW = await this._readChargePowerW(st);
    const maxW = maxA * phases * V, minW = minA * phases * V;
    const availW = teslaW - grid - buffer;
    const surplusA = Math.floor(Math.max(0, Math.min(maxW, availW)) / (phases * V));
    const act = await this._readActual(st);
    const actual = act.charging === true;   // de Tesla-boolean is leidend (charging_on/charging_state)
    const atHome = !act.dc;   // DC-snelladen = Supercharger = onderweg → niet sturen
    const chargePowerKw = act.powerKw;
    this._trackEvEnergy(act.chargeAdded);   // EV-energie betrouwbaar boeken (één bron voor ledger + device)
    if (availW >= minW) { if (!this._surplusSince) this._surplusSince = now; } else { this._surplusSince = 0; }
    const sustainedOk = this._surplusSince && (now - this._surplusSince) >= startMin * 60_000;

    // Prijs-horizon (voor de goedkoopste-uren-fallback van het verplichte deel).
    const horizon = (await this._blendedHorizon()).sort((a, b) => a.t - b.t);
    const cur = horizon.find(h => now >= h.t && now < h.t + SLOT_MIN * 60_000);
    const curPrice = cur ? cur.import_eur : null;

    let decision = 'idle', reason = '', want = false, amps = 0, cap = mandatory, tier = null;
    let nextChargeIso = null, readyByIso = null, kwhNeeded = 0;

    if (!connected) { decision = 'skip_disconnected'; reason = 'auto niet verbonden'; this._surplusSince = 0; }
    else if (soc == null) { decision = 'skip_no_soc'; reason = 'SoC onbekend'; }
    else if (soc <= floor) { want = true; amps = maxA; cap = Math.max(mandatory, ceiling); decision = 'panic_charge'; reason = `SoC ${soc}% ≤ vloer ${floor}% — laden`; }
    else if (soc >= ceiling) { decision = 'at_target'; reason = `SoC ${soc}% ≥ plafond ${ceiling}%`; this._surplusSince = 0; }
    else if (soc < mandatory) {
      // VERPLICHT deel: gratis overschot eerst, anders goedkoopste uren tot deadline.
      cap = mandatory;
      kwhNeeded = Math.max(0, (mandatory - soc) / 100 * capKwh) / EFFICIENCY;
      const slotKwh = (maxW / 1000) * SLOT_H;
      const within  = horizon.filter(h => h.t >= now - SLOT_MIN * 60_000 && h.t <= dlMs);
      const sel = this._pickCheapest(within, kwhNeeded, slotKwh, new Set());
      if (sel.lastTs) readyByIso = new Date(sel.lastTs + SLOT_MIN * 60_000).toISOString();
      const fut = [...sel.set].filter(t => t >= now - SLOT_MIN * 60_000);
      if (fut.length) nextChargeIso = new Date(Math.min(...fut)).toISOString();

      if (sustainedOk) { want = true; amps = Math.max(minA, surplusA); tier = 'overschot'; decision = 'charge_surplus'; reason = `verplicht via gratis overschot @ ${amps}A`; }
      else if (now > dlMs) { want = true; amps = maxA; decision = 'past_deadline'; reason = `deadline voorbij, SoC ${soc}% < ${mandatory}% — doorladen`; }
      else if (!cur) { want = true; amps = maxA; decision = 'no_prices'; reason = 'geen prijs — laden'; }
      else if (sel.set.has(cur.t)) { want = true; amps = maxA; tier = 'verplicht'; decision = 'charge_mandatory'; reason = `goedkoop uur €${curPrice?.toFixed(3) ?? '?'} → verplicht laden`; }
      else { want = false; decision = 'wait_cheaper'; reason = `wacht op overschot, anders goedkoop uur ~${readyByIso ? this.app.localTime(new Date(readyByIso)) : '?'}`; }
    }
    else {
      // OPPORTUNISTISCH deel (doel→plafond): UITSLUITEND op zonne-overschot.
      cap = ceiling;
      if (actual) {
        const onLong = (now - (this._chargeStartedTs || 0)) >= minOnMs;
        if (surplusA < minA) {
          if (!this._belowSince) this._belowSince = now;
          const belowLong = (now - this._belowSince) >= stopMin * 60_000;
          if (onLong && belowLong) { want = false; decision = 'surplus_stop'; reason = 'overschot weg'; }
          else { want = true; amps = minA; decision = 'surplus_hold'; reason = 'kort dal — op minimum'; }
        } else { this._belowSince = 0; want = true; amps = surplusA; tier = 'overschot'; decision = 'surplus_follow'; reason = `volgt overschot @ ${amps}A`; }
      } else {
        const offLong = (now - (this._chargeStoppedTs || 0)) >= minOffMs;
        if (sustainedOk && offLong) { want = true; amps = Math.max(minA, surplusA); tier = 'overschot'; decision = 'surplus_start'; reason = `overschot → start @ ${amps}A`; }
        else { want = false; decision = 'surplus_wait'; reason = 'wacht op zon-overschot (boven doel, geen netinkoop)'; }
      }
    }

    // Sturen — reconcile naar 'want' met backoff + wake (start én stop kunnen
    // een slapende auto vereisen; cap = laadlimiet zodat de auto zelf stopt).
    let commanded = null, verify = null;
    if (connected && soc != null && live && decision !== 'skip_no_soc' && atHome) {
      const ampChange = want && Math.abs((this._lastAmps ?? -99) - Math.round(amps)) >= 2;
      const mismatch  = (actual !== want) || ampChange;
      const wishChanged = this._sLastWant !== want;
      const lastFailed  = !!this._lastDriveError;
      const streak      = this._sStreak || 0;
      const givenUp     = streak >= MAX_DRIVE_ATTEMPTS;
      const interval    = givenUp ? GIVEUP_MS : (lastFailed ? FAIL_RETRY_MS : RECONCILE_MS);
      const due         = wishChanged || ampChange || (Date.now() - (this._sLastTs || 0)) >= interval;

      if (mismatch && due) {
        this._sStreak = wishChanged ? 1 : streak + 1;
        if (!givenUp && (actual !== want)) {
          const cs = await this._carState();
          if (cs && cs !== 'online') { await this._wake(); verify = `wake#${this._sStreak}`; }
        }
        const ok = await this._drive(want, cap, want ? amps : undefined);
        if (ok) {
          commanded = want ? `start@${Math.round(amps)}A` : 'stop';
          if (want && !actual) this._chargeStartedTs = now;
          if (!want && actual) this._chargeStoppedTs = now;
        }
        this._sLastWant = want; this._sLastTs = Date.now(); this._bumpCmd();
        if (this._sStreak === MAX_DRIVE_ATTEMPTS) {
          this.app.notifications?.send(`⚠️ Tesla volgt het ${want ? 'start' : 'stop'}-commando niet (${this._lastDriveError || '?'}) — controleer de auto.`, 'tesla');
        }
      } else if (!mismatch) {
        this._sStreak = 0; this._lastDriveError = null;
      }
    }

    const tsLocal = this.app.localTime();
    const rec = {
      ts: new Date().toISOString(), ts_local: tsLocal, mode: 'combi', sturing: this._mode(),
      connected, soc, target_pct: mandatory, ceiling_pct: ceiling, tier,
      charging_actual: connected ? actual : null, away_dc: !atHome, charge_power_kw: chargePowerKw,
      decision, reason, charge_now: want, amps: Math.round(amps),
      kwh_needed: +kwhNeeded.toFixed(2),
      ready_by_local: readyByIso ? this.app.localTime(new Date(readyByIso)) : null,
      next_charge_local: nextChargeIso ? this.app.localTime(new Date(nextChargeIso)) : null,
      current_price_eur: curPrice, commanded, verify,
      drive_error: this._lastDriveError || null, cmd_count_today: this._cmdCount,
    };
    this._last = {
      decision, reason, charge_now: want, amps: Math.round(amps), tier,
      target_pct: mandatory, ceiling_pct: ceiling, soc, connected,
      charging_actual: connected ? actual : null,
      away_dc: !atHome, charge_power_kw: chargePowerKw,
      ev_energy_ac_kwh: this._evTotalAcKwh ?? 0,
      kwh_needed: rec.kwh_needed, ready_by_local: rec.ready_by_local,
      next_charge_local: rec.next_charge_local, current_price_eur: curPrice,
      mode: this._mode(), updated_local: tsLocal,
    };
    this._ring.push(rec);
    if (this._ring.length > RING_MAX) this._ring.shift();
    this._appendJsonl(rec);
    this.app.log(`[TeslaSched] combi ${decision}${commanded ? ` → ${live ? 'LIVE' : 'DRYRUN'} ${commanded}` : ''}${verify ? ` [${verify}]` : ''} | SoC ${soc ?? '?'}%→${mandatory}%(plafond ${ceiling}%) | ${reason}`);
  }

  /** Grid-vermogen (P1): import +, export −. */
  async _readGridW() {
    try {
      const d = this.homey.settings.get('decisionlog_devices') || {};
      const dev = await this.app.getDevice(d.p1 || 'ec398f63-5125-49d2-95aa-94b822d055b6');
      const v = dev?.capabilitiesObj?.measure_power?.value;
      return typeof v === 'number' ? v : 0;
    } catch (_) { return 0; }
  }

  /**
   * Huidig EV-laadvermogen (W). Prefereert de adapter-state (powerW, alleen >0 mét
   * Wall Connector/charger-device); val anders terug op het Tesla-batterij-device.
   */
  async _readChargePowerW(st = null) {
    if (st && st.connected && (st.powerW ?? 0) > 0) return st.powerW;
    try {
      const dev = await this.app.getDevice(this._teslaBatId());
      const kw = dev?.capabilitiesObj?.measure_charge_power?.value;
      return typeof kw === 'number' ? kw * 1000 : 0;
    } catch (_) { return 0; }
  }

  /** Auto-staat (online/asleep/…) — gratis check vóór een (dure) wake. */
  async _carState() {
    try {
      const dev = await this.app.getDevice(this._teslaCarId());
      return dev?.capabilitiesObj?.car_state?.value ?? null;
    } catch (_) { return null; }
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

  /**
   * Fase B — aaneengesloten-bewuste keuze die TOTALE kosten minimaliseert:
   *   kosten = Σ(energieprijs van gekozen slots) + n_sessies × C_session
   * waarbij C_session (€) de kosten van een extra laadsessie-start vat (wake-credits +
   * opspin-verlies + slijtage). Zo wordt alleen gesplitst als de prijsbesparing van wachten
   * groter is dan die sessie-kosten:
   *   • twee aangrenzende goedkope blokken → doorladen (één blok), want bridgen < C_session;
   *   • goedkoop / duur-ertussen / later goedkoper → wél splitsen, want besparing > C_session.
   * Kandidaten: 1 aaneengesloten blok, 2 blokken, en de losse-goedkoopste set (met run-penalty,
   * dekt 3+ dips). Aanname: de horizon is in de tijd aaneengesloten (PricePredictor-slots).
   */
  _pickContiguousOptimal(slots, kwhNeeded, slotKwh, excludeSet, sessionEur) {
    const set = new Set(); let count = 0, lastTs = null;
    if (kwhNeeded <= 0 || slotKwh <= 0) return { set, count, lastTs };
    const avail = slots.filter(s => !excludeSet || !excludeSet.has(s.t)).sort((a, b) => a.t - b.t);
    const N = avail.length;
    const n = Math.min(N, Math.ceil(kwhNeeded / slotKwh));
    if (n <= 0) return { set, count, lastTs };
    if (n >= N) { avail.forEach(s => set.add(s.t)); return { set, count: N, lastTs: avail[N - 1].t }; }

    const price = avail.map(s => s.import_eur ?? 0);
    const pre = [0];
    for (let i = 0; i < N; i++) pre.push(pre[i] + price[i]);
    const winCost = (s, len) => (pre[s + len] - pre[s]) * slotKwh;       // € energie
    const runsOf = (idxs) => { const a = [...idxs].sort((x, y) => x - y); let r = 0; for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1] + 1) r++; return r; };

    let best = { cost: Infinity, idxs: null };
    // k=1: één aaneengesloten blok van n slots
    for (let s = 0; s + n <= N; s++) {
      const c = winCost(s, n) + sessionEur;
      if (c < best.cost) best = { cost: c, idxs: Array.from({ length: n }, (_, k) => s + k) };
    }
    // k=2: twee disjuncte blokken (lengtes a en n−a)
    for (let a = 1; a < n; a++) {
      const b = n - a;
      for (let sa = 0; sa + a <= N; sa++) {
        for (let sb = 0; sb + b <= N; sb++) {
          if (sb + b <= sa || sb >= sa + a) {                            // disjunct
            const c = winCost(sa, a) + winCost(sb, b) + 2 * sessionEur;
            if (c < best.cost) {
              const idxs = [];
              for (let k = 0; k < a; k++) idxs.push(sa + k);
              for (let k = 0; k < b; k++) idxs.push(sb + k);
              best = { cost: c, idxs };
            }
          }
        }
      }
    }
    // losse goedkoopste n slots, met run-penalty (dekt 3+ dips als dat goedkoper is)
    {
      const order = avail.map((s, i) => ({ i, p: price[i] })).sort((x, y) => x.p - y.p).slice(0, n).map(o => o.i);
      const c = order.reduce((acc, i) => acc + price[i] * slotKwh, 0) + runsOf(order) * sessionEur;
      if (c < best.cost) best = { cost: c, idxs: order };
    }

    best.idxs.forEach(i => set.add(avail[i].t));
    count = set.size; lastTs = set.size ? Math.max(...set) : null;
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

  _tempBucket(t) {
    if (t == null) return 'unknown';
    if (t < 5)  return 'lt5';
    if (t < 15) return '5_15';
    if (t < 25) return '15_25';
    return 'gt25';
  }

  async _readModuleTemp() {
    try {
      const dev = await this.app.getDevice(this._teslaBatId());
      const v = dev?.capabilitiesObj?.module_temp?.value;
      return (typeof v === 'number') ? v : null;
    } catch (_) { return null; }
  }

  _ewmaSet(key, value, a = 0.3, lo = -Infinity, hi = Infinity, dp = 2) {
    if (!(value > lo && value < hi)) return;
    const prev = this.homey.settings.get(key);
    const ewma = (typeof prev === 'number') ? prev * (1 - a) + value * a : value;
    this.homey.settings.set(key, +ewma.toFixed(dp));
  }

  /**
   * Fase A — lerend tijd/temp-model (OBSERVE-ONLY, stuurt nog geen beslissingen):
   *  • steady-state laadsnelheid (kWh/h) als EWMA, globaal én per temp-bucket (module_temp);
   *  • per-sessie overhead (= duur − ΔSoC·min/%), terug-gerekend bij sessie-einde;
   *  • elke voltooide sessie als JSONL-regel (/userdata/tesla-sessions.jsonl).
   */
  async _learn(st, cap) {
    const charging = st?.charging ?? false;     // intentie (charging_on/charging_state)
    const soc = st?.soc ?? null;
    const now = Date.now();
    const temp = await this._readModuleTemp();
    this._lastModuleTemp = temp;            // voor het temp-afhankelijke ratemodel (fase C)

    // Sessie-grenzen.
    if (charging && !this._session) {
      this._session = { startTs: now, startSoc: soc, tempSum: temp ?? 0, tempN: (temp != null ? 1 : 0) };
    } else if (!charging && this._session) {
      this._finalizeSession(now, soc, cap);
      this._session = null;
    }

    // Steady-state slope (alleen tijdens laden, SoC gestegen ≥5 min).
    if (charging && soc != null) {
      if (this._session && temp != null) { this._session.tempSum += temp; this._session.tempN++; }
      if (!this._rateSample) { this._rateSample = { ts: now, soc }; return; }
      const dtH  = (now - this._rateSample.ts) / 3_600_000;
      const dSoc = soc - this._rateSample.soc;
      if (dtH >= 0.083 && dSoc > 0) {
        const kwhPerH = (dSoc / 100 * cap) / dtH;
        if (kwhPerH > 1 && kwhPerH < 50) {
          this._ewmaSet('tesla_observed_kwh_per_h', kwhPerH);                  // globaal (huidige beslissingen)
          this._ewmaSet(`tesla_learn_rate_${this._tempBucket(temp)}`, kwhPerH); // per temp-bucket (fase C)
        }
        this._rateSample = { ts: now, soc };
      } else if (dSoc < 0) {
        this._rateSample = { ts: now, soc };
      }
    } else {
      this._rateSample = null;
    }
  }

  /** Sessie-einde: overhead terugrekenen + sessie loggen. */
  _finalizeSession(now, socEnd, cap) {
    const s = this._session;
    const durMin = (now - s.startTs) / 60_000;
    const dSoc = (socEnd ?? s.startSoc) - s.startSoc;
    const avgTemp = s.tempN ? s.tempSum / s.tempN : null;
    const bucket = this._tempBucket(avgTemp);
    const rate = this.homey.settings.get(`tesla_learn_rate_${bucket}`)
              || this.homey.settings.get('tesla_observed_kwh_per_h');
    let overhead = null;
    if (dSoc >= 3 && rate > 1 && durMin > 0) {
      const minPerPct = 0.6 * cap / rate;            // min per %  (= (cap/100)/rate u × 60)
      overhead = durMin - dSoc * minPerPct;
      if (overhead > -2 && overhead < 30) {
        this._ewmaSet('tesla_learn_overhead_min', Math.max(0, overhead), 0.3, -1, 1e9, 1);
        overhead = +Math.max(0, overhead).toFixed(1);
      } else { overhead = null; }                    // implausibel → niet leren
    }
    this._appendSessionLog({
      ts: new Date().toISOString(),
      start_local: this.app.localTime(new Date(s.startTs)),
      end_local: this.app.localTime(new Date(now)),
      soc_start: s.startSoc, soc_end: socEnd, d_soc: dSoc,
      duration_min: +durMin.toFixed(1),
      avg_module_temp: avgTemp != null ? +avgTemp.toFixed(1) : null,
      temp_bucket: bucket,
      rate_kwh_h: rate ? +(+rate).toFixed(2) : null,
      overhead_min: overhead,
      wake_secs: this._lastWakeSecs ?? null,
    });
  }

  _appendSessionLog(rec) {
    try {
      fs.appendFileSync(path.join(USERDATA_DIR, 'tesla-sessions.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) { this.app.error('[TeslaSched] sessielog:', e.message); }
  }

  /**
   * Effectieve laadsnelheid (kW), temp-bewust (fase C):
   *   1) geleerde snelheid voor de huidige temp-bucket (module_temp) → "winter langer";
   *   2) val terug op de globale EWMA;  3) anders de berekende powerKw (prior).
   */
  _effectiveRateKw(powerKw, temp = null) {
    const plausible = (v) => (typeof v === 'number' && v > 1 && v < 50);
    const byTemp = this.homey.settings.get(`tesla_learn_rate_${this._tempBucket(temp)}`);
    if (plausible(byTemp)) return byTemp;
    const obs = this.homey.settings.get('tesla_observed_kwh_per_h');
    if (plausible(obs)) return obs;
    return powerKw;
  }

  /** Geleerde overhead (min) per laadsessie — ramp/aanloop; prior = 3 min. */
  _overheadMin() {
    const v = this.homey.settings.get('tesla_learn_overhead_min');
    return (typeof v === 'number' && v >= 0 && v < 30) ? v : 3;
  }

  /** Geleerde wektijd (s) — tijd tot de auto 'online' is; prior = 60 s. */
  _wakeLeadSec() {
    const v = this.homey.settings.get('tesla_learn_wake_secs');
    return (typeof v === 'number' && v > 0 && v < 120) ? v : 60;
  }

  // Stuurt de Tesla. Start/stop = de SETTABLE capability `charging_on` (betrouwbaar, werkt direct).
  // Laadlimiet + laadstroom kan een app NIET zelf zetten (flow-acties → "Missing Scopes"); die gaan
  // via trigger-bruggen (`ems:setEvChargeLimit` / `ems:setEvChargeCurrent`) die de gebruiker aan de
  // Tesla-acties "Stel Laadlimiet SoC in" / "Stel laadstroom in" koppelt.
  async _drive(wantCharge, capPct, ampsOverride) {
    const dev = this._teslaBatId();
    try {
      // Hoofd-stop: laadlimiet = capPct ("laad tot X%"). De auto stopt hier zelf, ook slapend ladend.
      const limit = Math.max(50, Math.min(100, Math.round(capPct)));
      if (this._lastLimit !== limit) { this.homey.emit('ems:setEvChargeLimit', limit); this._lastLimit = limit; }

      // Timing: start/stop via de settable capability `charging_on` (betrouwbaar).
      await this.app.setDeviceCapability(dev, 'charging_on', !!wantCharge);

      // Amps zetten bij laden (vol vermogen, of opgegeven surplus-amps).
      if (wantCharge) {
        const want = ampsOverride != null ? ampsOverride : this._params().maxA;
        const amps = Math.max(1, Math.min(32, Math.round(want)));
        if (this._lastAmps !== amps) { this.homey.emit('ems:setEvChargeCurrent', amps); this._lastAmps = amps; }
      }
      this._lastDriveError = null;
      return true;
    } catch (err) {
      this._lastDriveError = err?.message || String(err);
      this.app.error('[TeslaSched] sturing-fout:', this._lastDriveError);
      return false;
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
