'use strict';

const Homey = require('homey');

/**
 * Tesla-thuislading als `evcharger`-device voor Homey Energy.
 * Eén virtueel device (de Tesla laadt thuis via een gewoon stopcontact/UMC, niet via een
 * gemeten Wall Connector) — het vermogen komt uit de TeslaScheduler. Zo krijgt Homey Energy
 * de tot nu toe onzichtbare EV-laadenergie, en wordt "Overig" het échte huishouden.
 */
class EvChargerDriver extends Homey.Driver {
  async onPairListDevices() {
    return [{ name: 'Tesla thuislading', data: { id: 'tesla-home-evcharger' } }];
  }
}

module.exports = EvChargerDriver;
