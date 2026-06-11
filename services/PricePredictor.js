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
   * Echte uur-prijzen (vandaag + morgen, na ~13:00 gepubliceerd) via EnergyZero.
   * Alleen actief als day_ahead_provider === 'energyzero'. Geen API-key nodig.
   * Geeft een Map(hourStartMs → all-in €/kWh), of null. Cache 1u.
   */
  async getActualPrices() {
    if ((this.homey.settings.get('day_ahead_provider') || '') !== 'energyzero') return null;
    const now = Date.now();
    if (this._ezMap && (now - this._ezAt) < 60 * 60 * 1000) return this._ezMap;
    try {
      const ymd  = d => d.toISOString().substring(0, 10);
      const from = new Date(now), till = new Date(now + 24 * 60 * 60 * 1000);
      const url  = `https://api.energyzero.nl/v1/energyprices?fromDate=${ymd(from)}T00:00:00.000Z`
                 + `&tillDate=${ymd(till)}T23:59:59.999Z&interval=4&usageType=1&inclBtw=false`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`EnergyZero HTTP ${res.status}`);
      const data = await res.json();
      const pr   = data.Prices || data.prices || [];
      const HOUR = 3_600_000;
      const map  = new Map();
      for (const p of pr) {
        const t = new Date(p.readingDate).getTime();
        if (!isFinite(t) || typeof p.price !== 'number') continue;
        map.set(Math.floor(t / HOUR) * HOUR, +(p.price * BTW + EB_PLUS_INKOOP).toFixed(5));
      }
      if (!map.size) throw new Error('geen prijzen ontvangen');
      this._ezMap = map; this._ezAt = now;
      this.app.log(`[PricePredictor] EnergyZero actuals: ${map.size} uur (vandaag+morgen)`);
      return map;
    } catch (err) {
      this.app.error('[PricePredictor] EnergyZero-fout:', err.message);
      return this._ezMap || null;   // val terug op laatste bekende
    }
  }

  /** Forceer een verse ophaalslag (bv. nadat contract op dynamisch is gezet). */
  async refreshNow() {
    this._fetchedAt = 0;
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
      return {
        ts:         new Date(sec * 1000).toISOString(),
        kale_eur:   +kale.toFixed(5),
        import_eur: +(kale * P.btw + P.energyTax + P.supplierFee).toFixed(5),
        export_eur: +((kale + P.exportBonus) * P.exportFactor).toFixed(5),
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
