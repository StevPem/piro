// Run with: node test/slot-clock.test.js
'use strict';

const { SlotClock, currentSlotStart, nextSlotStart, msUntilNextSlot } = require('../src/audio/slot-clock');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

const SLOT_MS = 15000;

// --- pure boundary arithmetic ---

check(currentSlotStart(0, SLOT_MS) === 0, 'currentSlotStart(0) is 0');
check(currentSlotStart(14999, SLOT_MS) === 0, 'currentSlotStart just before a boundary stays in the previous slot');
check(currentSlotStart(15000, SLOT_MS) === 15000, 'currentSlotStart exactly on a boundary is that boundary');
check(currentSlotStart(22345, SLOT_MS) === 15000, 'currentSlotStart mid-slot rounds down to the slot start');
check(currentSlotStart(30001, SLOT_MS) === 30000, 'currentSlotStart just after a later boundary');

check(nextSlotStart(0, SLOT_MS) === 15000, 'nextSlotStart(0) is the first real boundary, not 0 itself');
check(nextSlotStart(14999, SLOT_MS) === 15000, 'nextSlotStart just before a boundary is that boundary');
check(nextSlotStart(15000, SLOT_MS) === 30000, 'nextSlotStart exactly on a boundary is the *next* one, not itself');
check(nextSlotStart(22345, SLOT_MS) === 30000, 'nextSlotStart mid-slot rounds up to the next boundary');

check(msUntilNextSlot(0, SLOT_MS) === 15000, 'msUntilNextSlot(0) is a full slot');
check(msUntilNextSlot(14999, SLOT_MS) === 1, 'msUntilNextSlot just before a boundary is 1ms');
check(msUntilNextSlot(15000, SLOT_MS) === 15000, 'msUntilNextSlot exactly on a boundary is a full slot (the next one)');

// Real UTC-alignment sanity check against a wall-clock timestamp, not
// just 0-based arithmetic — FT8 slots are anchored to the actual UTC
// epoch, so an off-by-one in how the modulo is applied to a large
// real-world ms value would otherwise slip through purely 0-based tests.
{
  const knownUtcMs = Date.UTC(2026, 0, 1, 12, 0, 7, 250); // 2026-01-01T12:00:07.250Z — 7.25s into its slot
  const expectedSlotStart = Date.UTC(2026, 0, 1, 12, 0, 0, 0);
  check(
    currentSlotStart(knownUtcMs, SLOT_MS) === expectedSlotStart,
    'currentSlotStart aligns to real UTC slot boundaries, not just 0-based offsets'
  );
  check(
    nextSlotStart(knownUtcMs, SLOT_MS) === expectedSlotStart + SLOT_MS,
    'nextSlotStart aligns to the real UTC boundary 15s later'
  );
}

// --- SlotClock: fires 'boundary' events against an injectable fake clock/timer ---

function makeFakeScheduler(startMs) {
  let now = startMs;
  let scheduled = null; // { fn, dueAt }
  return {
    now: () => now,
    setTimer: (fn, delay) => {
      scheduled = { fn, dueAt: now + delay };
      return scheduled;
    },
    clearTimer: (handle) => {
      if (scheduled === handle) scheduled = null;
    },
    // Advances the fake clock and fires the scheduled callback if its
    // due time has passed — simulates real timer behavior without
    // waiting on one.
    advance(ms) {
      now += ms;
      while (scheduled && scheduled.dueAt <= now) {
        const { fn } = scheduled;
        scheduled = null;
        fn();
      }
    },
    isScheduled: () => scheduled !== null,
  };
}

{
  const sched = makeFakeScheduler(1000); // 1s into the first slot
  const clock = new SlotClock({ slotMs: SLOT_MS, now: sched.now, setTimer: sched.setTimer, clearTimer: sched.clearTimer });
  const fired = [];
  clock.on('boundary', (info) => fired.push(info));

  clock.start();
  check(sched.isScheduled(), 'start() arms a timer immediately');
  check(fired.length === 0, 'no boundary fires before the timer is due');

  sched.advance(14000); // now at 15000, exactly the first boundary
  check(fired.length === 1, 'fires exactly one boundary event at the first real boundary');
  check(fired[0].slotStartMs === 15000, 'the fired event carries the correct slot-start timestamp');

  sched.advance(15000); // one full slot later
  check(fired.length === 2, 'fires again at the next boundary, having re-armed itself');
  check(fired[1].slotStartMs === 30000, 'the second event carries the next slot-start timestamp');
}

{
  const sched = makeFakeScheduler(0);
  const clock = new SlotClock({ slotMs: SLOT_MS, now: sched.now, setTimer: sched.setTimer, clearTimer: sched.clearTimer });
  let fired = 0;
  clock.on('boundary', () => fired++);
  clock.start();
  clock.stop();
  sched.advance(30000);
  check(fired === 0, 'stop() cancels the pending timer so no further boundaries fire');
  check(clock.running === false, 'running reflects the stopped state');
}

{
  const sched = makeFakeScheduler(0);
  const clock = new SlotClock({ slotMs: SLOT_MS, now: sched.now, setTimer: sched.setTimer, clearTimer: sched.clearTimer });
  clock.start();
  clock.start(); // calling start() again while already running should be a no-op, not a second timer
  check(clock.running === true, 'start() is idempotent while already running');
}

{
  let threw = false;
  try {
    new SlotClock({ slotMs: 0 });
  } catch {
    threw = true;
  }
  check(threw, 'constructing with a non-positive slotMs throws rather than silently misbehaving');
}

// --- setSlotMs(): runtime switching between FT8's 15s and FT4's 7.5s grids ---

{
  let threw = false;
  const clock = new SlotClock({ slotMs: SLOT_MS });
  try {
    clock.setSlotMs(0);
  } catch {
    threw = true;
  }
  check(threw, 'setSlotMs() rejects a non-positive slotMs, same as the constructor');
  check(clock.slotMs === SLOT_MS, 'a rejected setSlotMs() call leaves the previous slotMs untouched');
}

{
  // Switching while stopped just updates slotMs — no timer to re-arm.
  const sched = makeFakeScheduler(0);
  const clock = new SlotClock({ slotMs: SLOT_MS, now: sched.now, setTimer: sched.setTimer, clearTimer: sched.clearTimer });
  clock.setSlotMs(7500);
  check(clock.slotMs === 7500, 'setSlotMs() updates slotMs while stopped');
  check(!sched.isScheduled(), 'setSlotMs() while stopped does not arm a timer');
}

{
  // Switching while running re-arms immediately against the *new* grid,
  // rather than waiting out the delay already scheduled against the old
  // one — see setSlotMs()'s own doc comment for why this matters (a
  // switch mid-FT8-slot shouldn't wait up to 15s to take effect).
  const sched = makeFakeScheduler(1000); // 1s into a 15s slot; next FT8 boundary would be at 15000
  const clock = new SlotClock({ slotMs: SLOT_MS, now: sched.now, setTimer: sched.setTimer, clearTimer: sched.clearTimer });
  const fired = [];
  clock.on('boundary', (info) => fired.push(info));
  clock.start();

  clock.setSlotMs(7500); // switch to FT4 grid at t=1000; next 7.5s boundary is at 7500, not 15000
  check(clock.slotMs === 7500, 'setSlotMs() updates slotMs immediately');
  check(clock.running === true, 'switching the slot grid does not stop the clock');

  sched.advance(6500); // now at 7500 — the new grid's boundary, well before the old grid's 15000 one
  check(fired.length === 1 && fired[0].slotStartMs === 7500, 'after switching grids while running, the clock fires at the *new* grid\'s next boundary, not the old one');
  check(fired[0].slotMs === 7500, 'the fired boundary event reports the new slotMs');

  sched.advance(7500);
  check(fired.length === 2 && fired[1].slotStartMs === 15000, 'subsequent boundaries keep following the new 7.5s grid');
}

{
  // Switching back and forth (mirrors toggling the FT8/FT4 UI button
  // repeatedly) should keep working, re-arming each time.
  const sched = makeFakeScheduler(0);
  const clock = new SlotClock({ slotMs: SLOT_MS, now: sched.now, setTimer: sched.setTimer, clearTimer: sched.clearTimer });
  clock.start();
  clock.setSlotMs(7500);
  clock.setSlotMs(15000);
  check(clock.slotMs === 15000, 'setSlotMs() can be called repeatedly, ending back at the original value');
  check(sched.isScheduled(), 'the clock still has a timer armed after switching grids twice');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
