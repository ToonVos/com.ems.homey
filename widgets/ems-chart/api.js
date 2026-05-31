'use strict';

module.exports = {

  async getState({ homey }) {
    return homey.app.ems.getPublicState();
  },

  async getPlan({ homey }) {
    return homey.app.ems.planningEngine
      ? homey.app.ems.planningEngine.getCurrentPlan()
      : null;
  },

  async getTodayPlan({ homey }) {
    return homey.app.ems.planningEngine
      ? homey.app.ems.planningEngine.getTodayPlan()
      : null;
  },

  async getActuals({ homey }) {
    const now  = new Date();
    const year = now.getFullYear();
    const mon  = String(now.getMonth() + 1).padStart(2, '0');
    const day  = String(now.getDate()).padStart(2, '0');
    const date = `${year}${mon}${day}`;

    const result = [];
    for (let h = 0; h < 24; h++) {
      for (let s = 0; s < 6; s++) {
        const d = homey.settings.get(`actuals_${date}_${h}_${s}`);
        if (!d || d.n === 0) {
          result.push(null);
        } else {
          result.push({ pvW: d.pvW, gridW: d.gridW, batW: d.batW, evW: d.evW });
        }
      }
    }
    return result;
  },

};
