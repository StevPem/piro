'use strict';

// Run with: node test/rigctl-server.test.js
// The Hamlib-style control port (src/server/rigctl-server.js) against a real
// ControlServer with a stand-in radio: rigctld's replies, byte for byte;
// changes going through ControlServer's checks (refused while
// transmitting, broadcast to browsers); PTT off unless allowed, released
// when the program disconnects, and data PTT only in DATA mode. Then
// Hamlib's own client (rigctl -m 2, "NET rigctl") against it, if Hamlib is
// installed.

const net = require('net');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { ControlServer } = require('../src/server/ws-server');
const { EVENT } = require('../src/server/protocol');
const { RigctlServer, rawToStrength, rawToSwr, dumpState, MAX_CLIENTS } = require('../src/server/rigctl-server');

let failures = 0;
// Kept, since parts of the run silence console.log (server messages).
const print = console.log;
const printError = console.error;
function check(cond, msg) {
  if (cond) print(`ok - ${msg}`);
  else {
    printError(`FAIL - ${msg}`);
    failures++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A radio that records what it is told. */
class Radio extends EventEmitter {
  constructor() {
    super();
    this.radioAddr = 0x94;
    Object.assign(this, { mode: 'USB', filter: 1, freq: 14074000, dataMode: false, ptt: false, power: 50, smeter: 126, swr: 48, alc: 60 });
    this.log = [];
  }
  async getFrequency() { return this.freq; }
  async setFrequency(hz) { this.log.push(`freq ${hz}`); this.freq = hz; }
  async getMode() { return { mode: this.mode, filter: this.filter }; }
  async setMode(mode, filter = 1) { this.log.push(`mode ${mode} ${filter}`); Object.assign(this, { mode, filter, dataMode: false }); }
  async getDataMode() { return this.dataMode; }
  async setDataMode(on) { this.log.push(`data ${on}`); this.dataMode = on; }
  async setPtt(on) { this.log.push(`ptt ${on}`); this.ptt = on; }
  async getTxPower() { return this.power; }
  async setTxPower(w) { this.log.push(`power ${w}`); this.power = w; return w; }
  async getSMeter() { return this.smeter; }
  async getSWR() { return this.swr; }
  async getAlc() { return this.alc; }
}

function controlServer(radio, opts = {}) {
  const cs = new ControlServer({ civ: radio, port: 0, heartbeatMs: 0, ...opts });
  cs.events = [];
  const broadcast = cs._broadcast.bind(cs);
  cs._broadcast = (payload, except) => {
    try {
      cs.events.push(JSON.parse(payload));
    } catch {
      // not JSON
    }
    return broadcast(payload, except);
  };
  return cs;
}

/** A raw rigctl client: send a line, read until the reply is complete. */
class Client {
  static async open(port) {
    const c = new Client();
    c.socket = net.connect(port, '127.0.0.1');
    c.buf = '';
    c.closed = false;
    c.socket.setEncoding('latin1');
    c.socket.on('data', (d) => (c.buf += d));
    c.socket.on('close', () => (c.closed = true));
    c.socket.on('error', () => {});
    await new Promise((r) => c.socket.once('connect', r));
    return c;
  }
  /** Sends `line`; resolves with the reply once `lines` lines (or an RPRT line) arrived. */
  async cmd(line, lines = 1) {
    this.buf = '';
    this.socket.write(`${line}\n`);
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      const got = this.buf.split('\n').slice(0, -1);
      if (got.length >= lines || got.some((l) => l.startsWith('RPRT'))) return this.buf;
      await sleep(5);
    }
    return this.buf;
  }
  close() {
    this.socket.end();
  }
}

const guard = setTimeout(() => {
  console.error('FAIL - the tests did not finish within 60 s');
  process.exit(1);
}, 60000);

async function run() {
  const quiet = { log: console.log, warn: console.warn };

  // ---------------- replies, as rigctld gives them ----------------
  {
    const radio = new Radio();
    const cs = controlServer(radio);
    const rs = new RigctlServer({ controlServer: cs, port: 0, version: 'PiRO test' });
    const port = await rs.start();
    console.log = () => {};
    const c = await Client.open(port);
    console.log = quiet.log;

    check((await c.cmd('\\get_powerstat')) === '1\n', '\\get_powerstat: 1');
    check((await c.cmd('\\chk_vfo')) === '0\n', '\\chk_vfo: 0 (no VFO argument)');
    const dump = await c.cmd('\\dump_state', 200);
    check(dump.startsWith('1\n3073\n0\n30000.000000 74800000.000000 ') && dump.endsWith('rigctld_version=PiRO test\ndone\n'), '\\dump_state: protocol 1, model 3073 (IC-7300), ends with "done"');
    check(dump.includes('\n0x0\n0x0\n0x74001000\n0x1000\n0x0\n0x0\n'), '\\dump_state: levels read RFPOWER, RAWSTR, SWR, ALC, STRENGTH; set RFPOWER');
    check(dump.includes('ptt_type=0x1\n'), '\\dump_state: PTT by command');
    check((await c.cmd('f')) === '14074000\n', 'f: the frequency');
    check((await c.cmd('\\get_freq')) === '14074000\n', '\\get_freq: the same, by its long name');
    check((await c.cmd('m', 2)) === 'USB\n3000\n', 'm: USB, 3000 Hz (FIL1)');
    check((await c.cmd('v')) === 'VFOA\n', 'v: VFOA');
    check((await c.cmd('s', 2)) === '0\nVFOA\n', 's: split off, VFOA');
    check((await c.cmd('t')) === '0\n', 't: 0');
    check((await c.cmd('+f', 3)) === 'get_freq:\nFrequency: 14074000\nRPRT 0\n', '+f: extended reply');
    check((await c.cmd('+m', 4)) === 'get_mode:\nMode: USB\nPassband: 3000\nRPRT 0\n', '+m: extended reply');
    check((await c.cmd('+l RFPOWER', 3)) === 'get_level: RFPOWER\n0.500000\nRPRT 0\n', '+l RFPOWER: extended reply, 50 W is 0.5');
    check((await c.cmd('\\nonsense')) === 'RPRT -11\n', 'an unknown command: RPRT -11');
    check((await c.cmd('x')) === 'RPRT -11\n', 'a command not offered (x, split mode): RPRT -11');
    check((await c.cmd('F')) === 'RPRT -1\n', 'F with no frequency: RPRT -1');
    check((await c.cmd('F abc')) === 'RPRT -1\n', 'F abc: RPRT -1');
    check((await c.cmd('M FOO 0')) === 'RPRT -1\n', 'M FOO: RPRT -1');
    check((await c.cmd('l STRENGTH')) === '0\n', 'l STRENGTH: raw 126 is S9, 0 dB');
    check((await c.cmd('l RAWSTR')) === '126\n', 'l RAWSTR: the raw S-meter value');
    check((await c.cmd('l SWR')) === '1.500000\n', 'l SWR: raw 48 is 1.5');
    check((await c.cmd('l ALC')) === '0.500000\n', 'l ALC: raw 60 of 120 is 0.5');
    check((await c.cmd('l AF')) === 'RPRT -11\n', 'l AF (not offered): RPRT -11');
    check(radio.log.length === 0, 'none of that changed the radio');

    // Changes go through ControlServer, which tells the browsers.
    check((await c.cmd('F 7074000.000000')) === 'RPRT 0\n' && radio.freq === 7074000, 'F 7074000.000000: set');
    check(cs.events.some((e) => e.type === EVENT.FREQUENCY && e.data.value === 7074000), 'and the browsers are told the new frequency');
    radio.log = [];
    check((await c.cmd('M PKTUSB 0')) === 'RPRT 0\n' && radio.dataMode && radio.mode === 'USB', 'M PKTUSB 0: USB with DATA mode');
    check(radio.log.join() === 'data true', `from USB, only DATA mode is turned on (${radio.log.join()})`);
    check((await c.cmd('m', 2)) === 'PKTUSB\n1200\n', 'm: PKTUSB, 1200 Hz (the IC-7300\'s USB-D FIL1)');
    radio.log = [];
    check((await c.cmd('M PKTUSB -1')) === 'RPRT 0\n' && radio.log.length === 0, 'M PKTUSB again: nothing sent, so the filter stays as it is');
    check((await c.cmd('M PKTUSB 500')) === 'RPRT 0\n' && radio.filter === 2 && radio.dataMode, 'M PKTUSB 500: FIL2, and DATA mode put back after the filter change');
    check(radio.log.join() === 'mode USB 2,data true', `the order: mode with the filter, then DATA mode (${radio.log.join()})`);
    radio.log = [];
    check((await c.cmd('M CW 0')) === 'RPRT 0\n' && radio.mode === 'CW' && !radio.dataMode, 'M CW 0: CW');
    check((await c.cmd('M USB 0')) === 'RPRT 0\n' && radio.mode === 'USB' && !radio.dataMode, 'M USB 0: plain USB');
    check((await c.cmd('L RFPOWER 0.25')) === 'RPRT 0\n' && radio.power === 25, 'L RFPOWER 0.25: 25 W');
    check((await c.cmd('L RFPOWER 2')) === 'RPRT -1\n' && radio.power === 25, 'L RFPOWER 2 (above 1): RPRT -1');
    check((await c.cmd('V VFOA')) === 'RPRT 0\n' && (await c.cmd('V VFOB')) === 'RPRT -11\n', 'V VFOA accepted; VFOB not offered');
    check((await c.cmd('S 0 VFOA')) === 'RPRT 0\n' && (await c.cmd('S 1 VFOB')) === 'RPRT -11\n', 'S 0 accepted; split on not offered');

    // PTT is off unless allowed; unkeying always works.
    radio.log = [];
    console.warn = () => {};
    check((await c.cmd('T 1')) === 'RPRT -11\n' && !radio.ptt, 'T 1 without RIGCTL_PTT: RPRT -11, radio not keyed');
    console.warn = quiet.warn;
    check((await c.cmd('T 0')) === 'RPRT 0\n' && radio.log.join() === 'ptt false', 'T 0 is always allowed');

    // Refused while transmitting, like a browser's request.
    await cs.setPttFromServer(true);
    radio.log = [];
    check((await c.cmd('F 14074000')) === 'RPRT -9\n' && radio.freq === 7074000, 'F while transmitting: RPRT -9, radio unchanged');
    check((await c.cmd('M PKTUSB 0')) === 'RPRT -9\n' && !radio.dataMode, 'M while transmitting: RPRT -9');
    check((await c.cmd('L RFPOWER 1')) === 'RPRT -9\n' && radio.power === 25, 'L RFPOWER while transmitting: RPRT -9');
    check((await c.cmd('t')) === '1\n', 't while transmitting: 1');
    check((await c.cmd('f')) === '7074000\n', 'reads still work while transmitting');
    check(radio.log.filter((l) => !l.startsWith('ptt')).length === 0, 'nothing changed on the keyed radio');
    await cs.releasePtt();

    console.log = () => {};
    c.close();
    await rs.stop();
    console.log = quiet.log;
    cs.close();
  }

  // ---------------- PTT when allowed ----------------
  {
    const radio = new Radio();
    const cs = controlServer(radio, { pttWatchdogMs: 300 });
    const rs = new RigctlServer({ controlServer: cs, port: 0, allowPtt: true });
    const port = await rs.start();
    console.log = () => {};
    console.warn = () => {};
    const c = await Client.open(port);

    check((await c.cmd('T 1')) === 'RPRT 0\n' && radio.ptt, 'T 1 with RIGCTL_PTT: keyed');
    check(cs.state.ptt && cs.events.some((e) => e.type === EVENT.PTT && e.data.value === true), 'and the browsers see PTT on');
    check((await c.cmd('t')) === '1\n', 't: 1');
    check((await c.cmd('T 0')) === 'RPRT 0\n' && !radio.ptt, 'T 0: unkeyed');
    check((await c.cmd('T 3')) === 'RPRT -9\n' && !radio.ptt, 'T 3 (data PTT) without DATA mode: RPRT -9, not keyed');
    radio.dataMode = true;
    check((await c.cmd('T 3')) === 'RPRT 0\n' && radio.ptt, 'T 3 in DATA mode: keyed');
    await sleep(500);
    check(!radio.ptt && cs.events.some((e) => e.type === EVENT.PTT_TIMEOUT), 'the PTT watchdog unkeys it, as for a browser');

    // While CW may still be sending (a receive hold), PTT is refused.
    cs.holdReceiveConfirmation('cw-test');
    console.error = () => {};
    check((await c.cmd('T 1')) === 'RPRT -9\n' && !radio.ptt, 'T 1 while CW may still be sending: RPRT -9, not keyed');
    console.error = printError;
    check((await c.cmd('t')) === '1\n', 't then: 1 (may still be transmitting)');
    await cs.confirmReceive('cw-test');

    check((await c.cmd('T 1')) === 'RPRT 0\n' && radio.ptt, 'keyed again');
    c.close();
    await sleep(100);
    check(!radio.ptt && !cs.state.ptt, 'the program disconnecting releases its PTT');
    check(cs.externalClients.size === 0, 'and it is no longer a client');

    // A browser's PTT isn't released when a rigctl program leaves.
    const c2 = await Client.open(port);
    await cs.setPttFromServer(true);
    c2.close();
    await sleep(100);
    check(radio.ptt, 'a program leaving does not release PTT it did not key');
    await cs.releasePtt();

    // stop() closes connections and releases PTT they hold.
    const c3 = await Client.open(port);
    await c3.cmd('T 1');
    await rs.stop();
    await sleep(50);
    check(!radio.ptt && c3.closed, 'stop(): connections closed, PTT released');
    console.log = quiet.log;
    console.warn = quiet.warn;
    cs.close();
  }

  // ---------------- limits ----------------
  {
    const cs = controlServer(new Radio());
    const rs = new RigctlServer({ controlServer: cs, port: 0 });
    const port = await rs.start();
    console.log = () => {};
    console.warn = () => {};
    const clients = [];
    for (let i = 0; i < MAX_CLIENTS + 1; i++) clients.push(await Client.open(port));
    await sleep(100);
    check(clients[MAX_CLIENTS].closed && !clients[0].closed, `only ${MAX_CLIENTS} programs at once; the next is refused`);
    const long = clients[0];
    long.socket.write('f'.repeat(2000));
    await sleep(100);
    check(long.closed, 'a line over 1024 characters closes the connection');
    for (const c of clients) c.close();
    await rs.stop();
    console.log = quiet.log;
    console.warn = quiet.warn;
    cs.close();
  }

  // ---------------- the same meter readings as the browser ----------------
  {
    const vswr = await import(pathToFileURL(path.join(__dirname, '../src/client/vswr.js')).href);
    const smeter = await import(pathToFileURL(path.join(__dirname, '../src/client/smeter.js')).href);
    let same = true;
    for (let raw = 0; raw <= 255; raw++) if (Math.abs(rawToSwr(raw) - vswr.rawToVswr(raw)) > 1e-9) same = false;
    check(same, 'SWR: the same as the browser shows, for every raw value');
    const steps = smeter.S_METER_LEVELS.map((l) => rawToStrength(l.threshold));
    check(steps.join() === '-54,-48,-42,-36,-30,-24,-18,-12,-6,0,10,20,30,40,50,60', `STRENGTH at each S-meter step: S0 -54 dB to S9+60 (${steps.join()})`);
  }

  // ---------------- Hamlib's own client ----------------
  let hamlib = false;
  try {
    execFileSync('rigctl', ['--version'], { stdio: 'ignore' });
    hamlib = true;
  } catch {
    console.log('# skipped: Hamlib (rigctl) is not installed; checks with its own client not run');
  }
  if (hamlib) {
    const radio = new Radio();
    const cs = controlServer(radio);
    const rs = new RigctlServer({ controlServer: cs, port: 0, allowPtt: true });
    const port = await rs.start();
    console.log = () => {};
    console.warn = () => {};
    const rigctl = (...cmds) =>
      new Promise((resolve) => {
        execFile('rigctl', ['-m', '2', '-r', `127.0.0.1:${port}`, ...cmds], { timeout: 10000 }, (err, stdout, stderr) => resolve({ err, out: stdout, stderr }));
      });
    let r = await rigctl('f', 'm', 'v', 's', 't', 'l', 'RFPOWER', 'l', 'STRENGTH');
    console.log = quiet.log;
    check(!r.err && r.out === '14074000\nUSB\n3000\nVFOA\n0\nVFOA\n0\n0.500000\n0\n', `rigctl -m 2 opens it and reads frequency, mode, VFO, split, PTT and levels (${JSON.stringify(r.out)})`);
    console.log = () => {};
    r = await rigctl('F', '3573000', 'M', 'PKTUSB', '0', 'T', '1', 't', 'T', '0', 't');
    // Hamlib's client answers a read straight after its own set from its
    // cache, so read the mode back with a fresh client.
    const back = await rigctl('f', 'm');
    console.log = quiet.log;
    check(!r.err && r.out === '1\n0\n' && back.out === '3573000\nPKTUSB\n1200\n', `rigctl -m 2 sets frequency, data mode and PTT (${JSON.stringify(r.out + back.out)})`);
    check(radio.freq === 3573000 && radio.mode === 'USB' && radio.dataMode && !radio.ptt, 'and the radio was set: 3.573 MHz, USB with DATA mode, unkeyed');
    await cs.setPttFromServer(true);
    console.log = () => {};
    r = await rigctl('F', '7074000');
    console.log = quiet.log;
    check(radio.freq === 3573000 && /rejected|-9/i.test(r.out + r.stderr), 'rigctl -m 2 setting the frequency while transmitting is refused');
    await cs.releasePtt();
    console.log = () => {};
    await rs.stop();
    console.log = quiet.log;
    console.warn = quiet.warn;
    cs.close();
  }

  // dumpState() is plain text; every range line has 7 fields.
  {
    const lines = dumpState({ rigModel: 3073, version: 'x' });
    const ranges = lines.slice(3, lines.indexOf('0 0 0 0 0 0 0', lines.indexOf('0 0 0 0 0 0 0') + 1) + 1);
    check(ranges.every((l) => l.split(' ').length === 7), 'dump_state: every RX/TX range line has 7 fields');
  }

  clearTimeout(guard);
  if (failures) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll rigctl server tests passed.');
  }
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
