'use strict';

const { execFile } = require('child_process');

/**
 * Extracts the ALSA card identifier from a device string like
 * "plughw:CODEC,0" or "hw:1,0" -> "CODEC" / "1". Returns null if it
 * doesn't look like an ALSA hw/plughw device string.
 */
function alsaDeviceToCardId(alsaDevice) {
  const match = /^(?:plughw|hw|plug):([^,]+)/.exec(alsaDevice || '');
  return match ? match[1] : null;
}

/** Runs `amixer -c <cardId> scontrols` and returns the list of simple control names. */
function listSimpleControls(cardId, execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl('amixer', ['-c', cardId, 'scontrols'], (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const names = [];
      const re = /Simple mixer control '([^']+)',\d+/g;
      let m;
      while ((m = re.exec(stdout || ''))) names.push(m[1]);
      resolve(names);
    });
  });
}

/** Runs `amixer -c <cardId> sset '<name>' 100% unmute`. Resolves true/false, never rejects. */
function setControlMax(cardId, controlName, execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl('amixer', ['-c', cardId, 'sset', controlName, '100%', 'unmute'], (err) => {
      resolve(!err);
    });
  });
}

/**
 * Best-effort: sets every simple mixer control on the given ALSA card to
 * 100% (and unmuted, where that's meaningful). Used so the USB codec's
 * input/output gain doesn't get left at some unpredictable/low level
 * carried over from a previous session or the device's power-on default.
 *
 * Deliberately brute-force rather than targeting specific control names
 * ("Speaker", "Mic", "PCM", ...): those names vary across USB audio
 * codecs and aren't worth guessing at when we can just enumerate what's
 * actually there. Individual control failures (e.g. a boolean switch
 * that doesn't accept a percentage) are expected and ignored — this is a
 * convenience default, not a requirement for the app to function, so a
 * partial failure here should never block startup.
 *
 * `execFileImpl` is injectable for testing (defaults to the real
 * child_process.execFile) — no real ALSA hardware needed to test the
 * control-listing/invocation logic.
 *
 * @returns {Promise<Array<{name: string, ok: boolean}>>}
 */
async function maximizeVolume(cardId, execFileImpl = execFile) {
  if (!cardId) return [];
  const controls = await listSimpleControls(cardId, execFileImpl);
  const results = [];
  for (const name of controls) {
    const ok = await setControlMax(cardId, name, execFileImpl);
    results.push({ name, ok });
  }
  return results;
}

module.exports = { maximizeVolume, alsaDeviceToCardId, listSimpleControls, setControlMax };
