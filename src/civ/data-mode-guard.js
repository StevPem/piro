'use strict';

/**
 * Making sure the radio really is in DATA mode before (and while) audio is
 * transmitted.
 *
 * DATA mode (CI-V 1A 06) decides which input modulates the transmitter: the
 * USB audio PiRO plays with it on, the DATA OFF MOD source (usually the
 * microphone) with it off. Its OK reply only says the command was accepted.
 * When PTT followed straight on, a few milliseconds later, the IC-7300
 * sometimes started transmitting from the DATA OFF source: no output, just
 * a faint carrier, for the whole transmission. So the setting is read back
 * until it has taken, and PTT waits a moment after a change.
 *
 * A transmission that runs for minutes (SSTV, long TTY messages) also
 * watches it, and turns it back on if anything turns it off meanwhile (a
 * plain mode change, CI-V 06, clears DATA mode on Icom radios).
 */

const DEFAULT_SETTLE_MS = 300;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_WATCH_MS = 3000;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Turns DATA mode on (or off) and waits until the radio reports it so.
 * Nothing is sent if it already is. A radio driver without getDataMode()
 * (some test stubs) is just set and given the settle time.
 * @param {object} civ - CivDriver
 * @param {boolean} on
 * @param {{settleMs?: number, attempts?: number}} [opts]
 * @returns {Promise<boolean>} true if anything had to change
 * @throws if the radio still reports otherwise after `attempts` tries
 */
async function ensureDataMode(civ, on, { settleMs = DEFAULT_SETTLE_MS, attempts = DEFAULT_ATTEMPTS } = {}) {
  if (!civ || typeof civ.setDataMode !== 'function') return false; // no radio control to check
  const canRead = typeof civ.getDataMode === 'function';
  if (canRead) {
    try {
      if ((await civ.getDataMode()) === on) return false;
    } catch {
      // couldn't read it: set it anyway, below
    }
  }
  let last = null;
  for (let i = 0; i < attempts; i++) {
    await civ.setDataMode(on);
    await sleep(settleMs);
    if (!canRead) return true;
    try {
      last = await civ.getDataMode();
      if (last === on) return true;
    } catch (err) {
      last = err;
    }
  }
  const why = last instanceof Error ? ` (reading it back failed: ${last.message})` : '';
  throw new Error(`The radio did not turn DATA mode ${on ? 'on' : 'off'}${why}. Check that nothing else is changing the radio's mode.`);
}

/**
 * While a transmission runs: every `intervalMs`, reads DATA mode and turns
 * it back on if it has gone off, calling `onLost()` so the operator can be
 * told. Returns a function that stops watching (and waits for any check in
 * progress, so it never overlaps the CI-V commands that follow).
 */
function watchDataMode(civ, { intervalMs = DEFAULT_WATCH_MS, onLost } = {}) {
  if (typeof civ.getDataMode !== 'function') return async () => {};
  let stopped = false;
  let running = Promise.resolve();
  const timer = setInterval(() => {
    running = running.then(async () => {
      if (stopped) return;
      try {
        if ((await civ.getDataMode()) === false && !stopped) {
          await civ.setDataMode(true);
          onLost?.();
        }
      } catch {
        // a missed check; the next one will try again
      }
    });
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

module.exports = { ensureDataMode, watchDataMode, DEFAULT_SETTLE_MS, DEFAULT_WATCH_MS };
