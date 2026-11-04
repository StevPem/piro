'use strict';

// Run with: node test/cw-paddle-bridge.test.js
// The CW paddle timed at the radio's end (src/server/cw-paddle-bridge.js),
// with a fake clock (exact timing) and once on real timers.

const { EventEmitter } = require('events');
const { CwPaddleBridge, MAX_ELEMENT_MS } = require('../src/server/cw-paddle-bridge');
const { EVENT } = require('../src/server/protocol');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}
const tick = () => new Promise((r) => setImmediate(r));

/** A clock and timers the test moves by hand. */
function fakeTime() {
  let now = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, seq: id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    /** Runs every timer due up to `to`, in order, letting promises settle after each. */
    async advance(to) {
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        for (let i = 0; i < 5; i++) await tick();
      }
      now = Math.max(now, to);
      for (let i = 0; i < 5; i++) await tick(); // let promises settle even when no timer ran
    },
    pending: () => timers.size,
  };
}

/** A ControlServer stand-in with a radio that records key edges against the clock. */
function rig(time, { mode = 'CW', breakIn = 0 } = {}) {
  const edges = [];
  const civCalls = [];
  const civ = {
    breakIn,
    setKeyLine: async (line, on) => {
      edges.push({ line, on, at: time.now() });
      return true;
    },
    getBreakIn: async () => civ.breakIn,
    setBreakIn: async (v) => {
      civCalls.push(['setBreakIn', v]);
      civ.breakIn = v;
      return true;
    },
  };
  const cs = new EventEmitter();
  cs.civ = civ;
  cs.state = { mode: { mode, filter: 1 }, ptt: false, cwKeying: false };
  cs.events = [];
  cs.broadcastJsonEvent = (type, data) => cs.events.push({ type, data });
  cs.pttCalls = [];
  cs.setPttFromServer = async (on, opts) => {
    cs.pttCalls.push({ on, urgent: opts?.urgent, at: time.now() });
    cs.state.ptt = on;
  };
  return { cs, civ, edges, civCalls };
}

// "PARIS " at 20 WPM (60 ms units), as the browser's keyer would schedule it: [t, d]
function parisElements(unit = 60) {
  const letters = ['.--.', '.-', '.-.', '..', '...'];
  const out = [];
  let t = 0;
  letters.forEach((code, li) => {
    if (li) t += 2 * unit; // letter gap is 3 units: 1 already added after the last element
    for (const el of code) {
      const d = el === '-' ? 3 * unit : unit;
      out.push([t, d]);
      t += d + unit;
    }
  });
  return out;
}

async function run() {
  // Jittery arrival, even timing on air.
  {
    const time = fakeTime();
    const { cs, edges, civCalls } = rig(time);
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'dtr', delayMs: 250, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    bridge.start();
    const ws = {};
    const els = parisElements();
    // each element leaves the browser at its start and arrives 20 to 200 ms later (jitter up to 180 ms)
    const jitter = [20, 200, 35, 180, 60, 120, 20, 190, 75, 150, 40, 110, 200, 20];
    const t0 = time.now();
    // a WebSocket delivers in order: a delayed element holds back the ones behind it
    let prev = 0;
    const arrivals = els.map(([t, d], i) => {
      prev = Math.max(prev, t0 + t + jitter[i % jitter.length]);
      return { at: prev, t, d };
    });
    for (const a of arrivals) {
      await time.advance(a.at);
      bridge.key(ws, { session: 's1', t: a.t, d: a.d });
    }
    await time.advance(t0 + 10000);
    const downs = edges.filter((e) => e.on);
    const ups = edges.filter((e) => !e.on);
    check(downs.length === els.length && ups.length >= els.length, `every element keyed: ${downs.length} down, ${ups.length} up (one more up at the end)`);
    const base = downs[0].at - els[0][0];
    const timingOk = els.every(([t, d], i) => downs[i].at - base === t && ups[i].at - downs[i].at === d);
    check(timingOk, 'each element and gap on air is exactly as keyed, despite up to 180 ms of network jitter');
    check(base - arrivals[0].at === 250, `the whole sending is the fixed delay after the first element arrived (${base - arrivals[0].at} ms; ${base - t0} ms after it was keyed, with the 20 ms network trip)`);
    check(civCalls[0]?.[0] === 'setBreakIn' && civCalls[0][1] === 1, 'semi break-in turned on for the session (it was off)');
    check(civCalls.at(-1)?.[1] === 0 && cs.state.cwKeying === false, 'and put back to off when the session ends; cwKeying false');
    check(cs.events[0]?.type === EVENT.CW_KEYING && cs.events[0].data.active === true && cs.events.at(-1).data.active === false && cs.events.at(-1).data.reason === 'idle', 'cw-keying broadcast at the start and at the end (idle)');
    check(edges.at(-1).on === false, 'the key is up at the end');
    bridge.stop();
  }

  // Break-in already on is left alone.
  {
    const time = fakeTime();
    const { cs, civCalls } = rig(time, { breakIn: 2 });
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'rts', now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    bridge.start();
    bridge.key({}, { session: 'a', t: 0, d: 60 });
    await time.advance(time.now() + 10000);
    check(civCalls.length === 0, 'full break-in already on: not changed, not restored');
  }

  // A stall longer than the delay moves the rest later, keeping its timing.
  {
    const time = fakeTime();
    const { cs, edges } = rig(time);
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'dtr', delayMs: 100, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    bridge.start();
    const ws = {};
    const t0 = time.now();
    bridge.key(ws, { session: 's', t: 0, d: 60 });
    await time.advance(t0 + 400); // the next element is stuck in the network for 400 ms
    const r = bridge.key(ws, { session: 's', t: 120, d: 180 });
    bridge.key(ws, { session: 's', t: 360, d: 60 });
    await time.advance(t0 + 5000);
    const downs = edges.filter((e) => e.on).map((e) => e.at);
    const ups = edges.filter((e) => !e.on).map((e) => e.at);
    check(r.lateMs > 0, `the late element is reported (${r.lateMs} ms late)`);
    check(ups[1] - downs[1] === 180 && downs[2] - downs[1] === 240 && ups[2] - downs[2] === 60, 'its length, and the timing after it, are kept (the gap at the stall is longer)');
    check(downs.every((d, i) => i === 0 || d > ups[i - 1]), 'no element overlaps the one before');
  }

  // What is refused.
  {
    const time = fakeTime();
    const { cs } = rig(time);
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'dtr', now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    bridge.start();
    const ws = {};
    const refuses = (args, re, what) => {
      let msg = null;
      try {
        bridge.key(ws, args);
      } catch (err) {
        msg = err.message;
      }
      check(msg !== null && re.test(msg), `refused: ${what} (${msg})`);
    };
    refuses({ session: 'x', t: 0, d: MAX_ELEMENT_MS + 1 }, /"d"/, 'a key-down longer than 1.5 s (a stuck paddle)');
    refuses({ session: 'x', t: 0, d: 2 }, /"d"/, 'a key-down shorter than 10 ms');
    refuses({ session: 'x', t: -5, d: 60 }, /"t"/, 'a negative time');
    refuses({ session: '', t: 0, d: 60 }, /"session"/, 'no session');
    refuses({ session: 'x', t: NaN, d: 60 }, /"t"/, 'a time that is not a number');
    bridge.key(ws, { session: 'x', t: 500, d: 60 });
    refuses({ session: 'x', t: 100, d: 60 }, /in order/, 'an element earlier than the last');
    refuses({ session: 'x', t: 60000, d: 60 }, /too far ahead/, 'an element a minute ahead');
    let other = null;
    try {
      bridge.key({}, { session: 'y', t: 0, d: 60 });
    } catch (err) {
      other = err.message;
    }
    check(/Someone else is keying/.test(other || ''), 'a second browser while one is keying');
    bridge.stop();

    for (const [setup, re, what] of [
      [(c) => (c.state.mode = { mode: 'USB' }), /CW first/, 'the radio not in CW'],
      [(c) => (c.state.ptt = true), /already transmitting/, 'the radio already transmitting'],
      [(c) => (c.cwTxBusy = () => true), /CW text/, 'CW text being sent'],
    ]) {
      const t2 = fakeTime();
      const { cs: c2, edges } = rig(t2);
      setup(c2);
      const b2 = new CwPaddleBridge({ controlServer: c2, keyLine: 'dtr', now: t2.now, setTimer: t2.setTimer, clearTimer: t2.clearTimer });
      let msg = null;
      try {
        b2.key({}, { session: 's', t: 0, d: 60 });
      } catch (err) {
        msg = err.message;
      }
      await t2.advance(t2.now() + 2000);
      check(re.test(msg || '') && edges.length === 0 && !b2.active, `refused: ${what}, nothing keyed`);
    }
  }

  // The keying browser leaves: key up at once, the rest dropped.
  {
    const time = fakeTime();
    const { cs, edges, civCalls } = rig(time);
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'dtr', delayMs: 250, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    bridge.start();
    const ws = {};
    const t0 = time.now();
    bridge.key(ws, { session: 's', t: 0, d: 180 });
    bridge.key(ws, { session: 's', t: 240, d: 180 });
    bridge.key(ws, { session: 's', t: 480, d: 180 });
    await time.advance(t0 + 250 + 50); // mid first element
    check(edges.at(-1).on === true, 'keying under way');
    cs.emit('client-disconnected', {}); // someone else leaving: no effect
    check(bridge.active, 'another browser leaving changes nothing');
    cs.emit('client-disconnected', ws);
    await time.advance(time.now() + 1);
    check(edges.at(-1).on === false && !bridge.active, 'the keying browser leaving puts the key up at once');
    const downsBefore = edges.filter((e) => e.on).length;
    await time.advance(t0 + 5000);
    check(edges.filter((e) => e.on).length === downsBefore && time.pending() === 0, 'and nothing it had sent is keyed afterwards');
    check(civCalls.at(-1)?.[1] === 0, 'break-in put back');
    check(cs.events.at(-1).data.reason === 'browser disconnected', 'cw-keying false, reason: browser disconnected');
  }

  // stop() (shutdown) puts the key up.
  {
    const time = fakeTime();
    const { cs, edges } = rig(time);
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'dtr', delayMs: 50, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    bridge.start();
    bridge.key({}, { session: 's', t: 0, d: 1000 });
    await time.advance(time.now() + 100);
    bridge.stop();
    await time.advance(time.now() + 1);
    check(edges.at(-1).on === false && cs.cwPaddle === null, 'stop() puts the key up and detaches');
  }

  // A new session from the same browser ends the last; the 10-minute limit.
  {
    const time = fakeTime();
    const { cs } = rig(time);
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'dtr', now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, sessionMaxMs: 3000, sessionIdleMs: 2000 });
    bridge.start();
    const ws = {};
    bridge.key(ws, { session: 'one', t: 0, d: 60 });
    bridge.key(ws, { session: 'two', t: 0, d: 60 });
    check(cs.events.some((e) => e.data.active === false && e.data.reason === 'new session'), 'a new session id ends the last');
    let t = 0;
    let stopped = null;
    for (let i = 0; i < 100 && !stopped; i++) {
      await time.advance(time.now() + 500);
      t += 500;
      try {
        bridge.key(ws, { session: 'two', t, d: 60 });
      } catch (err) {
        stopped = err.message;
      }
    }
    check(/10 minutes/.test(stopped || '') && cs.events.at(-1).data.message?.includes('10 minutes'), 'a session that keeps going is stopped at the limit, with a message to every browser');
    bridge.stop();
  }

  // Without a key line: CI-V PTT per element, sent urgent, timed here.
  {
    const time = fakeTime();
    const { cs, civCalls } = rig(time);
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: null, delayMs: 200, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    bridge.start();
    const ws = {};
    const t0 = time.now();
    bridge.key(ws, { session: 's', t: 0, d: 60 });
    bridge.key(ws, { session: 's', t: 120, d: 180 });
    await time.advance(t0 + 10000);
    const p = cs.pttCalls;
    check(p.length === 4 && p.every((c) => c.urgent === true), 'PTT on and off per element, each sent urgent (ahead of polling)');
    check(p[0].at - t0 === 200 && p[1].at - p[0].at === 60 && p[2].at - p[0].at === 120 && p[3].at - p[2].at === 180, 'timed on the server clock as keyed');
    check(civCalls.length === 0, 'break-in left alone (as the paddle always did with PTT)');
  }

  // Real timers: arrivals with random jitter, key edges measured on the real clock.
  {
    const edges = [];
    const civ = {
      setKeyLine: async (line, on) => {
        edges.push({ on, at: performance.now() });
        return true;
      },
      getBreakIn: async () => 1,
      setBreakIn: async () => true,
    };
    const cs = new EventEmitter();
    cs.civ = civ;
    cs.state = { mode: { mode: 'CW' }, ptt: false };
    cs.broadcastJsonEvent = () => {};
    const bridge = new CwPaddleBridge({ controlServer: cs, keyLine: 'dtr', delayMs: 250 });
    bridge.start();
    const els = parisElements(60);
    const ws = {};
    const t0 = performance.now();
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // in order, as a WebSocket delivers them
    let prev = 0;
    const plan = els.map(([t, d]) => {
      prev = Math.max(prev, t + 20 + rand() * 180);
      return { at: prev, t, d };
    });
    for (const p of plan) {
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + p.at - performance.now())));
      bridge.key(ws, { session: 'real', t: p.t, d: p.d });
    }
    await new Promise((r) => setTimeout(r, 1500));
    bridge.stop();
    const downs = edges.filter((e) => e.on).map((e) => e.at);
    const ups = edges.filter((e) => !e.on).map((e) => e.at);
    const base = downs[0] - els[0][0];
    let worst = 0;
    els.forEach(([t, d], i) => {
      worst = Math.max(worst, Math.abs(downs[i] - base - t), Math.abs(ups[i] - downs[i] - d));
    });
    check(downs.length === els.length && worst < 15, `real timers, 20-200 ms of random network delay: every edge within ${worst.toFixed(1)} ms of as keyed (a unit is 60 ms)`);
    check(Math.abs(base - (t0 + plan[0].at) - 250) < 15, `the fixed 250 ms after the first element arrived (${(base - t0 - plan[0].at).toFixed(0)} ms)`);
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exitCode = 1;
  } else console.log('\nAll CW paddle tests passed.');
}

run().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
