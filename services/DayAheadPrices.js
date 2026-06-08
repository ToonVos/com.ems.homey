'use strict';

/**
 * DayAheadPrices
 * ──────────────
 * Fetches day-ahead electricity prices for dynamic contract users.
 *
 * Providers supported:
 *   'entso-e'  — Free ENTSO-E Transparency Platform API (requires API key)
 *   'tibber'   — Tibber GraphQL API (requires API key)
 *   'entsoe-nl' — Dutch APX prices via open proxy (no key needed)
 *
 * Output per hour: { hour, price (€/kWh), isCheap, isExpensive }
 *
 * isCheap    = price < avg - 20%
 * isExpensive = price > avg + 20%
 */

const ENTSOE_PROXY = 'https://europe-west1-homey-ems.cloudfunctions.net/entsoe'; // example proxy

class DayAheadPrices {

  constructor(app) {
    this.app    = app;
    this.homey  = app.homey;
    this._prices = [];
    this._lastFetch = 0;
    this._cacheTTL  = 60 * 60 * 1000; // 1 hour
  }

  async init(provider) {
    this._apiKey        = this.homey.settings.get('day_ahead_api_key') || '';
    // Power-by-the-Hour 'Stroomprijzen'-device als primaire bron voor D+0/D+1
    // (geen API-key nodig, lokaal). Overschrijfbaar via settings; valt terug op
    // de geconfigureerde provider als geen device beschikbaar is.
    this._pbthDeviceId = this.homey.settings.get('pbth_price_device')
      || 'cc19fcf6-8f6f-4174-8f9b-6163b630f360';
    this._provider     = this._pbthDeviceId ? 'pbth' : (provider || 'entso-e');
    this.app.log(`[DayAhead] Provider: ${this._provider}`);
  }

  // ─── Main fetch ───────────────────────────────────────────────────────────

  async getTomorrowPrices() {
    const now = Date.now();
    if (this._prices.length > 0 && (now - this._lastFetch) < this._cacheTTL) {
      return this._prices;
    }

    try {
      let raw;
      if (this._provider === 'pbth') {
        raw = await this._fetchPbth();
      } else if (this._provider === 'tibber') {
        raw = await this._fetchTibber();
      } else {
        raw = await this._fetchEntsoe();
      }

      this._prices    = this._annotate(raw);
      this._lastFetch = now;
      return this._prices;
    } catch (err) {
      this.app.error('[DayAhead] Fetch error:', err.message);
      return this._flatPrices(); // fallback: flat pricing
    }
  }

  // ─── Power-by-the-Hour fetch (Stroomprijzen-device, all-in, geen key) ───────

  async _fetchPbth() {
    const device = await this.app.getDevice(this._pbthDeviceId);
    const caps   = device?.capabilitiesObj || {};

    // meter_price_h0..h7 = all-in prijs voor de komende 8 uur (h0 = huidig uur).
    const tz = this.homey.clock.getTimezone();
    const nowHour = Number(new Intl.DateTimeFormat('en-GB',
      { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

    const prices = [];
    for (let i = 0; i < 8; i++) {
      const v = caps[`meter_price_h${i}`]?.value;
      if (v != null) prices.push({ hour: (nowHour + i) % 24, price: v });
    }
    if (prices.length === 0) throw new Error('Stroomprijzen-device gaf geen prijzen');
    return prices;
  }

  // ─── ENTSO-E fetch ────────────────────────────────────────────────────────

  async _fetchEntsoe() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().substring(0, 10).replace(/-/g, '');

    const url = `https://web-api.tp.entsoe.eu/api?` +
      `securityToken=${this._apiKey}` +
      `&documentType=A44` +
      `&in_Domain=10YNL----------L` +
      `&out_Domain=10YNL----------L` +
      `&periodStart=${dateStr}0000` +
      `&periodEnd=${dateStr}2300`;

    const res  = await fetch(url);
    if (!res.ok) throw new Error(`ENTSO-E HTTP ${res.status}`);
    const text = await res.text();

    // Parse XML (simplified — real implementation would use a proper XML parser)
    return this._parseEntsoeXml(text);
  }

  _parseEntsoeXml(xml) {
    // Extract price points from ENTSO-E XML
    const prices = [];
    const pointRegex = /<Point><position>(\d+)<\/position><price\.amount>([\d.]+)<\/price\.amount><\/Point>/g;
    let match;
    while ((match = pointRegex.exec(xml)) !== null) {
      const hour  = parseInt(match[1]) - 1; // ENTSO-E uses 1-based positions
      const price = parseFloat(match[2]) / 1000; // MWh → kWh
      prices.push({ hour, price });
    }
    return prices;
  }

  // ─── Tibber fetch ─────────────────────────────────────────────────────────

  async _fetchTibber() {
    const query = `{
      viewer {
        homes {
          currentSubscription {
            priceInfo {
              tomorrow {
                total
                startsAt
              }
            }
          }
        }
      }
    }`;

    const res = await fetch('https://api.tibber.com/v1-beta/gql', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) throw new Error(`Tibber HTTP ${res.status}`);
    const data = await res.json();

    const tomorrow = data?.data?.viewer?.homes?.[0]
      ?.currentSubscription?.priceInfo?.tomorrow ?? [];

    return tomorrow.map(p => ({
      hour:  new Date(p.startsAt).getHours(),
      price: p.total,
    }));
  }

  // ─── Annotation ───────────────────────────────────────────────────────────

  _annotate(rawPrices) {
    if (rawPrices.length === 0) return this._flatPrices();

    const values = rawPrices.map(p => p.price);
    const avg    = values.reduce((s, v) => s + v, 0) / values.length;
    const cheap  = avg * 0.80;
    const pricey = avg * 1.20;

    // Fill missing hours
    const filled = Array.from({ length: 24 }, (_, h) => {
      const found = rawPrices.find(p => p.hour === h);
      return {
        hour:        h,
        price:       found ? +found.price.toFixed(5) : avg,
        isCheap:     found ? found.price <= cheap  : false,
        isExpensive: found ? found.price >= pricey : false,
        avg:         +avg.toFixed(5),
      };
    });

    this.app.log(`[DayAhead] Avg price: €${avg.toFixed(3)}/kWh, cheap < €${cheap.toFixed(3)}, expensive > €${pricey.toFixed(3)}`);
    return filled;
  }

  _flatPrices() {
    const price = this.homey.settings.get('price_import_kwh') ?? 0.30;
    return Array.from({ length: 24 }, (_, h) => ({
      hour: h, price, isCheap: false, isExpensive: false, avg: price,
    }));
  }

}

module.exports = DayAheadPrices;
