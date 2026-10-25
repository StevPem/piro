'use strict';

/**
 * Sets the radio up for a picture mode that is only received (Radiofax,
 * EasyPal) and puts it back afterwards.
 *
 * These modes need the radio's NR and auto notch off and its widest filter
 * (FIL1). NR smears quick changes: on fax, thin lines vanish and strokes go
 * hollow (seen on VMC charts); on EasyPal it upsets the phase of the OFDM
 * carriers. The auto notch attacks steady tones, which is what a fax's
 * white or black area is, and what EasyPal's pilot carriers are.
 *
 * What setUp() changed is put back by restore(), and only if it is still as
 * set here (the operator may have changed it since). The filter is put back
 * only in the same mode: leaving for another mode picks that mode's filter.
 */
class ReceiveRadioSetup {
  /**
   * @param {object} opts
   * @param {object} opts.civ the CI-V driver
   * @param {string} opts.purpose for messages, e.g. 'fax'
   * @param {(message: string) => void} opts.report reports a failure
   */
  constructor({ civ, purpose, report }) {
    this.civ = civ;
    this.purpose = purpose;
    this.report = report;
    this.saved = null; // what setUp() changed: {nr, notch, filter, mode}
  }

  async setUp() {
    if (this.saved) return;
    const civ = this.civ;
    const saved = {};
    try {
      if (await civ.getNoiseReduction()) {
        await civ.setNoiseReduction(false);
        saved.nr = true;
      }
      if (await civ.getNotch()) {
        await civ.setNotch(false);
        saved.notch = true;
      }
      const filter = await civ.getFilter();
      if (filter !== 1) {
        saved.mode = (await civ.getMode?.())?.mode;
        await civ.setFilter(1);
        saved.filter = filter;
      }
    } catch (err) {
      this.report(`couldn't set the radio up for ${this.purpose} (NR off, notch off, FIL1): ${err.message}`);
    }
    this.saved = saved;
    if (Object.keys(saved).length) console.log(`Radio set up for ${this.purpose} (${Object.keys(saved).join(', ')} changed)`);
  }

  async restore() {
    const saved = this.saved;
    this.saved = null;
    if (!saved) return;
    const civ = this.civ;
    try {
      if (saved.nr && !(await civ.getNoiseReduction())) await civ.setNoiseReduction(true);
      if (saved.notch && !(await civ.getNotch())) await civ.setNotch(true);
      const modeNow = saved.mode && (await civ.getMode?.())?.mode;
      if (saved.filter && (await civ.getFilter()) === 1 && modeNow === saved.mode) await civ.setFilter(saved.filter);
    } catch (err) {
      this.report(`couldn't put the radio's settings back after ${this.purpose}: ${err.message}`);
    }
  }
}

module.exports = { ReceiveRadioSetup };
