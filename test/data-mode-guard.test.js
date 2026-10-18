// Run with: node test/data-mode-guard.test.js
'use strict';

const { ensureDataMode, watchDataMode } = require('../src/civ/data-mode-guard');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A radio whose DATA mode only takes on the `takesOn`-th command (Infinity: never). */
class Radio {
  constructor({ data = false, takesOn = 1 } = {}) {
    this.data = data;
    this.takesOn = takesOn;
    this.sets = [];
    this.reads = 0;
  }
  async setDataMode(on) {
    this.sets.push(on);
    if (this.sets.length >= this.takesOn) this.data = on;
  }
  async getDataMode() {
    this.reads++;
    return this.data;
  }
}

(async () => {
  {
    const r = new Radio({ data: true });
    const changed = await ensureDataMode(r, true, { settleMs: 0 });
    check(!changed && r.sets.length === 0 && r.reads === 1, 'already on: one read, nothing sent');
  }
  {
    const r = new Radio();
    const t0 = Date.now();
    const changed = await ensureDataMode(r, true, { settleMs: 50 });
    check(changed && r.sets.join() === 'true' && r.data && Date.now() - t0 >= 45, 'off: set, given the settle time, read back');
  }
  {
    const r = new Radio({ takesOn: 2 });
    await ensureDataMode(r, true, { settleMs: 0 });
    check(r.sets.length === 2 && r.data, 'a command the radio did not act on is sent again');
  }
  {
    const r = new Radio({ takesOn: Infinity });
    let err = null;
    await ensureDataMode(r, true, { settleMs: 0, attempts: 3 }).catch((e) => (err = e));
    check(err && /did not turn DATA mode on/.test(err.message) && r.sets.length === 3, 'gives up with a clear error after three tries: ' + err?.message);
  }
  {
    const r = new Radio({ data: true });
    await ensureDataMode(r, false, { settleMs: 0 });
    check(!r.data && r.sets.join() === 'false', 'turns it off the same way');
  }
  {
    const sets = [];
    const changed = await ensureDataMode({ setDataMode: async (on) => sets.push(on) }, true, { settleMs: 0 });
    check(changed && sets.join() === 'true', 'a driver that cannot read it back is just set');
    check((await ensureDataMode({}, true)) === false, 'no radio control at all: nothing to do');
  }
  {
    const r = new Radio({ data: true });
    let lost = 0;
    const stop = watchDataMode(r, { intervalMs: 20, onLost: () => lost++ });
    await sleep(70);
    check(lost === 0 && r.sets.length === 0 && r.reads >= 2, 'watching: while it stays on, only reads');
    r.data = false; // something turned it off mid-transmission
    await sleep(60);
    check(lost === 1 && r.data && r.sets.join() === 'true', 'turned off mid-transmission: turned back on, and reported once');
    await stop();
    const reads = r.reads;
    await sleep(60);
    check(r.reads === reads, 'stopped: no more checks');
  }

  console.log(failures ? `\n${failures} test(s) failed.` : '\nall DATA mode guard tests passed');
  process.exit(failures ? 1 : 0);
})();
