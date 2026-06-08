'use strict';

/**
 * ems-control widget API
 * ──────────────────────
 * Interactieve dashboard-tegel voor het Tesla-laaddoel (override van de
 * standaard 60% op 07:00). Praat met de app via homey.app-methodes.
 */
module.exports = {
  async getOverride({ homey }) {
    return homey.app.getTeslaOverride();
  },
  async setOverride({ homey, body }) {
    return homey.app.setTeslaOverride({
      target_pct:   body?.target_pct,
      deadline_iso: body?.deadline_iso,
    });
  },
  async clearOverride({ homey }) {
    return homey.app.clearTeslaOverride();
  },
};
