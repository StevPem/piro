'use strict';

/**
 * How a feature ends a transmission (see ControlServer#releasePtt and
 * #restoreWhenReceiving): release PTT and learn whether the radio confirmed
 * it, then put settings back only on a radio confirmed unkeyed. These
 * wrappers fall back to the plain calls for the small ControlServer
 * stand-ins some tests use.
 */

/**
 * For a held restore ({held: true}): whether the radio still has the value
 * the feature set, so putting the old one back won't undo a change made by
 * hand meanwhile (the option chosen for issues #75-#79). `read` reads it;
 * numbers match within `tolerance`. A failed read counts as changed: the
 * setting is left alone.
 */
async function settingStillIs(read, expected, tolerance = 0) {
  try {
    const now = await read();
    if (typeof expected === 'number' && typeof now === 'number') return Math.abs(now - expected) <= tolerance;
    return now === expected;
  } catch {
    return false;
  }
}

/** Unkeys; resolves true if the radio confirmed it, false if not (never rejects). */
async function releasePtt(controlServer) {
  if (typeof controlServer.releasePtt === 'function') return controlServer.releasePtt();
  try {
    await controlServer.setPttFromServer(false);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `restore({held})` now if the radio is confirmed unkeyed (resolving
 * true when done), or holds it until it is (resolving false at once).
 */
function restoreWhenReceiving(controlServer, restore) {
  if (typeof controlServer.restoreWhenReceiving === 'function') return controlServer.restoreWhenReceiving(restore);
  return Promise.resolve(restore({ held: false })).then(() => true);
}

/** Tells the ControlServer that "transmitting" may have changed (a feature keying without PTT). */
function refreshTransmitting(controlServer) {
  controlServer.refreshTransmitting?.();
}

const RELEASE_NOT_CONFIRMED = 'PTT release not confirmed: the radio may still be transmitting. Check the radio.';

module.exports = { releasePtt, restoreWhenReceiving, refreshTransmitting, settingStillIs, RELEASE_NOT_CONFIRMED };
