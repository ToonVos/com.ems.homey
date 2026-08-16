'use strict';

/**
 * PricePredictor (fork — meerdaagse prijs-pipeline)
 * ─────────────────────────────────────────────────
 * Haalt de meerdaagse EPEX-prijsvoorspelling op (EpexPredictor, b3nn0/Batzill)
 * en bouwt een all-in prijs-horizon voor ~7 dagen vooruit. Vult het gat dat de
 * PbtH-Stroomprijzen (alleen D+0/D+1) laat: nodig voor planning verder vooruit
 * (deadlines/vakantie meerdere dagen weg).
 *
 * Bron: https://epexpredictor.batzill.com/prices_short?region=NL&hours=168
 *   Antwoord: { s:[unix-sec, 15-min stappen], t:[kale prijs in ct/kWh] }
 *   Eenheid geverifieerd ct/kWh (MAE 1,74 ct/kWh; kruischeck vs Stroomprijzen).
 *
 * All-in (Zonneplan 2026, LOCKED): import = kale_€/kWh × 1,21 + €0,13085
 *                                  export = (kale_€/kWh + 0,02) × 1,10
 *
 * Read-only: alleen ophalen + rekenen. Cache 6u. API: getPriceHorizon.
 *
 * Actuals (D+0/D+1) komen apart binnen via `getActualPrices()`. Sinds de EPEX-MTU
 * per 1-10-2025 op 15 min staat en Zonneplan meegaat naar kwartier-afrekening is
 * Nord Pool de voorkeursbron: die levert de 96 kwartierprijzen per dag zonder key.
 * EnergyZero blijft beschikbaar maar kent alleen uurprijzen (geen 15-min-interval).
 */

const fs   = require('fs');
const path = require('path');

const URL          = 'https://epexpredictor.batzill.com/prices_short?region=NL&hours=168';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;     // 6 uur
const REFRESH_MS   = 6 * 60 * 60 * 1000;
const USERDATA_DIR = '/userdata';

// All-in formule-defaults (2026, Zonneplan + Belastingdienst). Per veld instelbaar via
// settings (invulvelden op de instellingen-pagina) — pas aan als tarieven wijzigen.
//   import = kale × btw + energiebelasting_incl + opslag_incl
//   export = (kale + sunbonus) × export_factor
const DEF_BTW            = 1.21;       // BTW-factor (21%)
const DEF_ENERGY_TAX_EUR = 0.1108;    // energiebelasting 2026 incl. btw (€/kWh)
const DEF_SUPPLIER_FEE_EUR = 0.0199892; // Zonneplan inkoopvergoeding/opslag 2026 incl. btw (€/kWh)
const DEF_EXPORT_BONUS_EUR = 0.02;    // Zonneplan Sunbonus (€/kWh)
const DEF_EXPORT_FACTOR  = 1.10;      // Zonneplan +10% terugleverbonus

const QUARTER = 900_000;              // EPEX-MTU sinds 1-10-2025
const HOUR    = 3_600_000;

class PricePredictor {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this._horizon = [];
    this._fetchedAt = 0;
    this._timer = null;
  }

  async init() {
    try { fs.mkdirSync(USERDATA_DIR, { recursive: true }); } catch (_) {}
    await this._refreshSafe();
    this._timer = this.homey.setInterval(() => this._refreshSafe(), REFRESH_MS);
    this.app.log('[PricePredictor] actief — EpexPredictor 168u all-in horizon, refresh 6u');
  }

  destroy() { if (this._timer) this.homey.clearInterval(this._timer); }

  /** Prijs-componenten uit settings (invulvelden), met 2026-defaults. */
  priceParams() {
    const s = this.homey.settings;
    const num = (k, d) => { const v = s.get(k); return (typeof v === 'number' && isFinite(v)) ? v : d; };
    return {
      btw:          num('price_btw_factor',     DEF_BTW),
      energyTax:    num('price_energy_tax_eur', DEF_ENERGY_TAX_EUR),
      supplierFee:  num('price_supplier_fee_eur', DEF_SUPPLIER_FEE_EUR),
      exportBonus:  num('price_export_bonus_eur', DEF_EXPORT_BONUS_EUR),
      exportFactor: num('price_export_factor',  DEF_EXPORT_FACTOR),
    };
  }

  /** Volledige horizon: [{ ts, kale_eur, import_eur, export_eur }] op 15-min resolutie. */
  getHorizon() { return this._horizon; }

  /** Compacte samenvatting voor de beslis-log. */
  getSummary() {
    if (this._horizon.length === 0) return { source: 'epexpredictor', available: false };
    const imp = this._horizon.map(h => h.import_eur);
    const cheapest = this._horizon.reduce((a, b) => (b.import_eur < a.import_eur ? b : a));
    return {
      source: 'epexpredictor',
      available: true,
      fetched_at: new Date(this._fetchedAt).toISOString(),
      points: this._horizon.length,
      hours: Math.round(this._horizon.length / 4),
      import_min: +Math.min(...imp).toFixed(4),
      import_max: +Math.max(...imp).toFixed(4),
      import_avg: +(imp.reduce((s, v) => s + v, 0) / imp.length).toFixed(4),
      cheapest_ts: cheapest.ts,
      cheapest_ts_local: this.app.localTime(new Date(cheapest.ts)),
      cheapest_import_eur: +cheapest.import_eur.toFixed(4),
    };
  }

  /** N goedkoopste komende 15-min-slots (voor latere planning). */
  getCheapestSlots(n = 8) {
    return [...this._horizon].sort((a, b) => a.import_eur - b.import_eur).slice(0, n);
  }

  // ─── intern ────────────────────────────────────────────────────────────────

  async _refreshSafe() {
    try { await this._refresh(); }
    catch (err) { this.app.error('[PricePredictor] refresh-fout:', err.message); }
  }

  /**
   * Resolutie (ms) van de laatst opgehaalde actuals: QUARTER bij Nord Pool,
   * HOUR bij EnergyZero. De consument moet hiermee de sleutel afronden.
   */
  actualStepMs() { return this._actualStep || HOUR; }

  /**
   * Echte marktprijzen (vandaag + morgen, morgen na ~13:00 CET gepubliceerd). Drie
   * keyless providers:
   *   'pbth-app'   — Power by the Hour (com.gruijter.powerhour) app-to-app-API, ons
   *                  eigen geconfigureerde device (bv. Zonneplan-tarief). Levert al-in
   *                  prijzen (markup al toegepast in dát device) — GEEN eigen
   *                  priceParams()-markup meer overheen, anders dubbel geteld.
   *   'nordpool'   — Nord Pool DataPortal, kale €/MWh, **kwartierprijzen** (96/dag,
   *                  EPEX 15-min MTU) → all-in via `priceParams()`.
   *   'energyzero' — EnergyZero, kale €/kWh, uurprijzen (interval=4; kent géén
   *                  15-min-interval) → all-in via `priceParams()`.
   * Geeft een Map(slotStartMs → all-in €/kWh) op de resolutie van `actualStepMs()`,
   * of null als de provider geen actuals levert. Cache 1u.
   */
  async getActualPrices() {
    const provider = this.homey.settings.get('day_ahead_provider') || '';
    if (!['pbth-app', 'energyzero', 'nordpool'].includes(provider)) return null;
    const now = Date.now();
    if (this._ezMap && this._ezProvider === provider && (now - this._ezAt) < 60 * 60 * 1000) {
      return this._ezMap;
    }
    try {
      if (provider === 'pbth-app') {
        const { map, step } = await this._fetchPbthAppMap();
        if (!map.size) throw new Error('geen prijzen ontvangen');
        this._ezMap = map; this._ezAt = now;
        this._ezProvider = provider; this._actualStep = step;
        this.app.log(`[PricePredictor] pbth-app actuals: ${map.size} `
          + `${step === QUARTER ? 'kwartieren' : 'uren'} (vandaag+morgen, al-in)`);
        return map;
      }

      const raw = provider === 'nordpool'
        ? await this._fetchNordpoolRaw(now)
        : await this._fetchEnergyZeroRaw(now);
      if (!raw.points.length) throw new Error('geen prijzen ontvangen');

      const P   = this.priceParams();
      const map = new Map();
      for (const { t, kale } of raw.points) {
        map.set(Math.floor(t / raw.step) * raw.step,
          +(kale * P.btw + P.energyTax + P.supplierFee).toFixed(5));
      }
      this._ezMap = map; this._ezAt = now;
      this._ezProvider = provider; this._actualStep = raw.step;
      this.app.log(`[PricePredictor] ${provider} actuals: ${map.size} `
        + `${raw.step === QUARTER ? 'kwartieren' : 'uren'} (vandaag+morgen)`);
      return map;
    } catch (err) {
      this.app.error(`[PricePredictor] ${provider}-fout:`, err.message);
      return (this._ezProvider === provider && this._ezMap) || null;   // val terug op laatste bekende
    }
  }

  /**
   * Power by the Hour app-to-app-API: `getApiApp('com.gruijter.powerhour').get('/dap-prices')`.
   * Geeft ALLE gepairde dap/dap15/dapg-devices met hun volledige toekomstige slot-array
   * (device.prices, incl. de door de gebruiker ingestelde markup — al-in `importPrice`).
   * Wij pakken specifiek het device dat `pbth_app_device_id` aanwijst (default: het eerst
   * gevonden 15-min NL-device), zodat een gebruiker met meerdere PbtH-devices (bv. ook
   * gas) niet per ongeluk de verkeerde als stroomprijs gebruikt.
   */
  async _fetchPbthAppMap() {
    const apiApp = this.homey.api.getApiApp('com.gruijter.powerhour');
    const payload = await apiApp.get('/dap-prices');
    const entries = payload?.prices || [];
    if (!entries.length) throw new Error('PbtH-app gaf geen devices terug');

    const wantId = this.homey.settings.get('pbth_app_device_id') || '';
    const entry = (wantId && entries.find(e => e.deviceId === wantId))
      || entries.find(e => e.driverType === 'dap15')
      || entries[0];
    if (!entry?.slots?.length) throw new Error(`geen prijzen voor device ${entry?.deviceName || '?'}`);

    const step = (entry.priceInterval || 60) * 60_000;
    const map = new Map();
    for (const s of entry.slots) {
      const t = new Date(s.time).getTime();
      if (!isFinite(t) || typeof s.importPrice !== 'number') continue;
      map.set(Math.floor(t / step) * step, +s.importPrice.toFixed(5));
    }
    return { map, step };
  }

  /**
   * Nord Pool DataPortal — day-ahead NL op native 15-min-resolutie, geen API-key.
   * Per leverdag één call (`deliveryDateCET`); morgen ontbreekt vóór de publicatie
   * rond 13:00 CET en telt dan gewoon niet mee. Prijzen zijn kale €/MWh.
   * Geverifieerd 16-08-2026: 96 punten/dag, uurgemiddelde identiek aan EnergyZero.
   */
  async _fetchNordpoolRaw(now) {
    const tz  = this.homey.clock.getTimezone();
    const ymd = d => new Intl.DateTimeFormat('en-CA',
      { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const days = [new Date(now), new Date(now + 24 * 60 * 60 * 1000)];

    const points = [];
    for (const day of days) {
      const url = 'https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices'
        + `?date=${ymd(day)}&market=DayAhead&deliveryArea=NL&currency=EUR`;
      let data;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch (err) {
        // Morgen nog niet gepubliceerd → geen fout, alleen een kortere horizon.
        if (day !== days[0]) continue;
        throw err;
      }
      for (const e of data.multiAreaEntries || []) {
        const t    = new Date(e.deliveryStart).getTime();
        const mwh  = e.entryPerArea?.NL;
        if (!isFinite(t) || typeof mwh !== 'number') continue;
        points.push({ t, kale: mwh / 1000 });          // €/MWh → €/kWh
      }
    }
    return { step: QUARTER, points };
  }

  /** EnergyZero — volledige uurreeks, geen API-key. Kale €/kWh (`inclBtw=false`). */
  async _fetchEnergyZeroRaw(now) {
    // Ruim UTC-venster (gister t/m overmorgen) zodat "vandaag+morgen" lokale tijd
    // er altijd volledig in valt, ongeacht zomertijd; de map is per uur gekeyd.
    const ymd  = d => d.toISOString().substring(0, 10);
    const from = new Date(now - 24 * 60 * 60 * 1000), till = new Date(now + 48 * 60 * 60 * 1000);
    const url  = `https://api.energyzero.nl/v1/energyprices?fromDate=${ymd(from)}T00:00:00.000Z`
               + `&tillDate=${ymd(till)}T23:59:59.999Z&interval=4&usageType=1&inclBtw=false`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`EnergyZero HTTP ${res.status}`);
    const data = await res.json();
    const points = [];
    for (const p of (data.Prices || data.prices || [])) {
      const t = new Date(p.readingDate).getTime();
      if (!isFinite(t) || typeof p.price !== 'number') continue;
      points.push({ t, kale: p.price });
    }
    return { step: HOUR, points };
  }

  /** Forceer een verse ophaalslag (bv. nadat contract op dynamisch is gezet). */
  async refreshNow() {
    this._fetchedAt = 0;
    this._ezMap = null; this._ezAt = 0;   // ook de actuals-cache met oude parameters weg
    this._ezProvider = null; this._actualStep = null;
    await this._refreshSafe();
  }

  async _refresh() {
    // De 7-daagse voorspeller hoort bij een dynamisch contract. Bij vast tarief
    // bestaat 'goedkoopste uur' niet → niet ophalen (bespaart API-calls).
    if ((this.homey.settings.get('contract_type') || 'fixed') !== 'dynamic') {
      if (this._horizon.length) { this._horizon = []; this._fetchedAt = 0; }
      return;
    }
    if (this._horizon.length && (Date.now() - this._fetchedAt) < CACHE_TTL_MS) return;

    const res = await fetch(URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`EpexPredictor HTTP ${res.status}`);
    const data = await res.json();
    const s = data.s || [];
    const t = data.t || [];
    if (s.length === 0 || s.length !== t.length) throw new Error(`onverwacht formaat (s=${s.length}, t=${t.length})`);

    const P = this.priceParams();
    this._horizon = s.map((sec, i) => {
      const kale = t[i] / 100;                                  // ct/kWh → €/kWh
      // Zonnebonus (Zonneplan): (kale + €0,02) × 1,10, maar alléén als die som positief is
      // (en formeel alleen overdag voor PV, niet voor batterij-ontlading; bij negatieve
      // prijs geldt gewoon de kale prijs). Bron: zonneplan.nl terugleververgoeding.
      const bonusBase = kale + P.exportBonus;
      return {
        ts:         new Date(sec * 1000).toISOString(),
        kale_eur:   +kale.toFixed(5),
        import_eur: +(kale * P.btw + P.energyTax + P.supplierFee).toFixed(5),
        export_eur: +(bonusBase > 0 ? bonusBase * P.exportFactor : kale).toFixed(5),
      };
    });
    this._fetchedAt = Date.now();

    const sum = this.getSummary();
    this._writeSnapshot(sum);
    this.app.log(
      `[PricePredictor] horizon ververst — ${sum.hours}u | import €${sum.import_min}–${sum.import_max} (gem €${sum.import_avg})` +
      ` | goedkoopst €${sum.cheapest_import_eur} @ ${sum.cheapest_ts_local}`
    );
  }

  _writeSnapshot(summary) {
    try {
      const day = new Date().toISOString().substring(0, 10).replace(/-/g, '');
      fs.appendFileSync(
        path.join(USERDATA_DIR, `pricehorizon-${day}.jsonl`),
        JSON.stringify({ ...summary, horizon: this._horizon }) + '\n'
      );
    } catch (err) { this.app.error('[PricePredictor] schrijffout:', err.message); }
  }

}

module.exports = PricePredictor;
