'use strict';

/**
 * NotificationManager
 * ───────────────────
 * Tijdlijn-meldingen met categorieën + ontdubbeling, zodat de gebruiker per
 * groep kan kiezen wat in de Homey-tijdlijn verschijnt (instellingen) en de
 * tijdlijn niet wordt volgespamd met identieke meldingen.
 *
 * Categorie aan/uit via settings-key `notify_<categorie>`. Default per categorie
 * in DEFAULTS (de chatty groepen staan standaard uit).
 */

// Standaard ALLES uit (gebruikerskeuze: rustige tijdlijn). Per groep weer aan te
// zetten via instellingen (notify_<categorie>).
const DEFAULTS = {
  plan:     false,
  battery:  false,
  session:  false,
  heatpump: false,
  ev:       false,
  tesla:    false,
  errors:   false,
  info:     false,
};

const DEDUPE_MS = 30 * 60 * 1000;   // identieke melding hooguit 1×/30 min

class NotificationManager {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this._recent = new Map();   // excerpt → laatste ts
  }

  _enabled(category) {
    const v = this.homey.settings.get(`notify_${category}`);
    return v == null ? (DEFAULTS[category] ?? true) : !!v;
  }

  /**
   * @param {string} message  tijdlijn-tekst
   * @param {string} [category='info']  groep voor aan/uit + ontdubbeling
   */
  async send(message, category = 'info') {
    try {
      if (!this._enabled(category)) return;

      const now = Date.now();
      const last = this._recent.get(message);
      if (last && (now - last) < DEDUPE_MS) return;   // identieke melding onderdrukken
      this._recent.set(message, now);
      if (this._recent.size > 60) {
        for (const [k, t] of this._recent) if (now - t > 60 * 60 * 1000) this._recent.delete(k);
      }

      await this.homey.notifications.createNotification({ excerpt: message });
    } catch (err) {
      this.app.error('[Notify] Error:', err.message);
    }
  }
}

module.exports = NotificationManager;
