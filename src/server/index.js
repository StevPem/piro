'use strict';

const fs = require('fs');
const path = require('path');
const { CivDriver, KNOWN_RADIO_ADDR } = require('../civ');
const { ControlServer } = require('./ws-server');
const { AudioBridge } = require('./audio-bridge');
const { ScopeBridge } = require('./scope-bridge');
const { CwDecoderBridge } = require('./cw-decoder-bridge');
const { RttyDecoderBridge } = require('./rtty-decoder-bridge');
const { Ft8Bridge } = require('../audio/ft8-bridge');
const { RadeBridge } = require('./rade-bridge');
const { FreeDvReporterBridge } = require('./freedv-reporter');

const SERIAL_PATH = process.env.CIV_SERIAL_PATH || '/dev/ttyUSB0';
const RADIO_MODEL = process.env.CIV_RADIO_MODEL; // e.g. "IC-7300"
// Must match the radio's own "CI-V USB Baud Rate" menu setting exactly —
// defaults to 19200 (CivDriver's own default) if unset. Spectrum scope
// data is high-volume enough that some setups need this raised (115200 is
// common) — see docs/civ-notes.md.
const CIV_BAUD_RATE = process.env.CIV_BAUD_RATE ? parseInt(process.env.CIV_BAUD_RATE, 10) : undefined;
const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 8080;
// Displayed as both the browser tab title and the on-screen heading —
// see docs/ui-notes.md for why this is sent to the client at connect
// time rather than baked into the served HTML.
const SCREEN_TITLE = process.env.SCREEN_TITLE || 'SPARC PiRO';
// The app's own version, shown next to SCREEN_TITLE — see docs/ui-notes.md.
// Read from src/client/sw.js's own CACHE_NAME ("icom-rig-pwa-shell-v62"
// -> "62") rather than package.json's version field: CACHE_NAME is the
// number that actually has to be bumped on every client-affecting change
// (see docs/pwa-notes.md's "bump this on every client change" section) —
// package.json's version was a SEPARATE number nobody was maintaining, so
// the on-screen version sat frozen at "v0.1.0" release after release while
// the shell cache version underneath it kept moving. Deriving it from
// sw.js instead means the on-screen number and the thing that actually
// governs whether a browser fetches the new shell can never drift apart,
// and there's exactly one version number to remember to bump, not two.
// Falls back to package.json's version if sw.js is ever missing/unreadable
// or CACHE_NAME doesn't match the expected "...-vN" shape, so a broken
// read here never crashes startup.
function readAppVersion() {
  try {
    const swSource = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');
    const match = swSource.match(/CACHE_NAME\s*=\s*'[^']*-v(\d+)'/);
    if (match) return match[1];
  } catch {
    // fall through to the package.json fallback below
  }
  return require('../../package.json').version;
}
const APP_VERSION = readAppVersion();
// The operator's own callsign/grid locator, used to build the default FT8
// CQ message ("CQ {CALLSIGN} {MAIDENHEAD}") and to drive the guided FT8
// QSO sequencer (see src/client/ft8-qso.js and docs/ui-notes.md) — neither
// exists anywhere else in this app (CI-V has no concept of "my callsign"),
// so this is the one place it's configured. Both are optional: with
// either unset, the FT8 composer simply starts empty and the guided
// sequence stays inactive, exactly like before this feature existed,
// rather than sending a broken/half-built message.
const STATION_CALLSIGN = process.env.STATION_CALLSIGN || null;
const STATION_GRID = process.env.STATION_GRID || null;

// Where this exact running instance's corresponding source is published —
// a fork, a tarball, whatever actually matches what's running. PiRO is
// AGPL-3.0-only (see README.md's "Licence" section, and models/deepcw/
// NOTICE.md for why), so anyone who interacts with it over the network is
// entitled to that source; since this project has no single canonical
// public repository URL of its own to hardcode, the operator configures
// wherever they're actually hosting their copy, and the client shows it
// as a "Source" link in the footer whenever it's set. Left unset, no link
// is shown — operators not distributing/running this for others (e.g.
// purely local personal use) have no §13 obligation to satisfy in the
// first place.
const SOURCE_CODE_URL = process.env.SOURCE_CODE_URL || null;

// FreeDV Reporter (https://qso.freedv.org) — reports this station's
// presence/frequency/TX state to the live FreeDV activity map whenever the
// client's FreeDV chip is armed. Reuses STATION_CALLSIGN/STATION_GRID
// above (same precondition as PSK Reporter below: reporting is a no-op
// without both) and is otherwise on by default, matching this app's own
// established convention for those two env vars (see pskSpotEnabled).
// Set FREEDV_REPORTER_ENABLED=0 to opt out without having to unset the
// callsign/grid used elsewhere (FT8 CQ messages, PSK Reporter). See
// src/server/freedv-reporter.js.
const FREEDV_REPORTER_ENABLED = !/^(0|false)$/i.test(process.env.FREEDV_REPORTER_ENABLED || '1');
// Override only for testing against a self-hosted FreeDV Reporter
// instance — unset uses the real public service.
const FREEDV_REPORTER_HOST = process.env.FREEDV_REPORTER_HOST || undefined;

// Audio is optional: only enabled if AUDIO_RX_DEVICE is set. Find your
// device names on the Pi with `arecord -l` / `aplay -l` — the radio's USB
// audio codec typically shows up as its own card, e.g. "plughw:1,0".
const AUDIO_RX_DEVICE = process.env.AUDIO_RX_DEVICE;
const AUDIO_TX_DEVICE = process.env.AUDIO_TX_DEVICE || AUDIO_RX_DEVICE;
const AUDIO_SAMPLE_RATE = process.env.AUDIO_SAMPLE_RATE
  ? parseInt(process.env.AUDIO_SAMPLE_RATE, 10)
  : 48000;
const AUDIO_CHANNELS = process.env.AUDIO_CHANNELS ? parseInt(process.env.AUDIO_CHANNELS, 10) : 1;
// 'pcm' (default) works in every browser via plain Web Audio; 'opus' is
// available for a future bandwidth-constrained scenario but isn't used by
// the current PWA client. See src/server/audio-bridge.js.
const AUDIO_CODEC = process.env.AUDIO_CODEC || 'pcm';
// RNNoise speech-denoiser binary (see src/audio/rnnoise-filter.js and
// docs/ui-notes.md) for the "RNN" toggle button — expected on PATH by
// default (matching RADE_TX_BIN/RADE_RX_BIN's own default-to-PATH
// convention below), not a full path, since the real `rnnoise_demo`
// binary (github.com/xiph/rnnoise, built via its own autotools build) has
// to be installed separately and isn't bundled with this app. Only
// affects the RX audio actually broadcast to clients — never the raw
// capture stream CW/RTTY/FT8/RADE decode from, see audio-bridge.js's own
// doc comment. Purely a config default: AudioBridge is constructed
// regardless (same as RADE below), and this only matters once a client
// actually switches the toggle on.
const RNNOISE_BIN = process.env.RNNOISE_BIN || 'rnnoise_demo';
// Configures the "RNN" button's non-off wet ratios (this project's own
// examples/rnnoise_demo.c, patched 2026-09-30 to blend the denoised and
// original signal at a fixed ratio per level — see that file's header
// comment and docs/audio-notes.md). RNNOISE_WET is a comma-separated list
// of ratios, one per level, e.g. "0.25, 0.5, 0.75, 1.0" for the original
// 4-level 25/50/75/100% default this feature shipped with -- but the
// LIST LENGTH is itself configurable: 3 values makes a 4-state button
// (Off + 3), 6 values makes a 7-state one (Off + 6), and so on. Each
// value is clamped to [0, 1] (1.0 = fully denoised/stock rnnoise_demo
// behavior, 0.0 = fully original/no denoising); an entry that doesn't
// parse as a number is dropped with a warning rather than crashing
// startup. Unset, empty, or entirely-unparseable input falls back to the
// original "0.25, 0.5, 0.75, 1.0" default (also enforced in
// audio-bridge.js itself, so direct construction without going through
// this env var — e.g. in tests — gets the same default).
//
// This list feeds TWO places that must agree on how many levels exist:
// AudioBridge (which level actually maps to which wet ratio — see
// RNNOISE_WET_LEVELS below and audio-bridge.js's own `_rnnoiseWetLevels`)
// and ControlServer (which validates an incoming SET_RNNOISE_LEVEL
// request's range, and tells the client how many states to render its
// button with — see `rnnoiseLevelCount` in ws-server.js/app.js). Both are
// derived from this SAME parsed array below rather than each parsing the
// env var themselves, so they can't drift out of sync with each other.
function parseRnnoiseWetLevels(raw) {
  const DEFAULT = [0.25, 0.5, 0.75, 1.0];
  if (raw == null || raw.trim() === '') return DEFAULT;
  const values = raw.split(',').map((token) => {
    const trimmed = token.trim();
    const value = parseFloat(trimmed);
    if (Number.isNaN(value)) {
      console.warn(`[rnnoise] RNNOISE_WET: ignoring unparseable entry "${trimmed}"`);
      return null;
    }
    const clamped = Math.max(0, Math.min(value, 1));
    if (clamped !== value) {
      console.warn(`[rnnoise] RNNOISE_WET: clamping ${value} to ${clamped} (must be 0.0-1.0)`);
    }
    return clamped;
  }).filter((v) => v !== null);
  if (values.length === 0) {
    console.warn(`[rnnoise] RNNOISE_WET="${raw}" had no usable values -- falling back to the default (${DEFAULT.join(', ')})`);
    return DEFAULT;
  }
  return values;
}
const RNNOISE_WET_LEVELS = parseRnnoiseWetLevels(process.env.RNNOISE_WET);
// +1 for level 0 ("RNN Off"), which isn't itself one of the configured
// wet ratios — see RNNOISE_WET_LEVELS above.
const RNNOISE_LEVEL_COUNT = RNNOISE_WET_LEVELS.length + 1;

// Which generation of HamNoise's bundled WASM models the "HamNoise" toggle
// uses — see src/audio/hamnoise-filter.js's own doc comment on its
// `quality` option for the full reasoning. Defaults to 'classic' (the
// older, much cheaper single-GRU models): measured directly against the
// bundled binaries, the newer 'v2' band-split-RNN models this feature
// originally defaulted to cost roughly 36-53% of real time per hop of
// audio on a fast x86 development machine, single-threaded and
// synchronous — a Raspberry Pi's much slower single-core performance
// pushes that over 100%, meaning it can't keep up at all, pinning the
// server at 100% CPU with no error to report (nothing's failing, it's
// just permanently behind) rather than denoising anything. Only set
// HAMNOISE_QUALITY=v2 on hardware you've confirmed is fast enough to
// actually keep up with it in real time.
const HAMNOISE_QUALITY = process.env.HAMNOISE_QUALITY === 'v2' ? 'v2' : 'classic';

// RADE (FreeDV's neural-vocoder mode) codec binaries — see
// docs/ui-notes.md for how to build/install rade_c
// (github.com/freedv/rade_c) and what these tools each do. All optional:
// if unset, the bare command name is used (works if the binaries are on
// PATH, e.g. installed to /usr/local/bin as documented). RadeBridge itself
// is only ever instantiated alongside AudioBridge (see below) — RADE
// decoding/encoding reads and writes the same PCM stream audio playback
// uses, the same hard dependency CW/RTTY/FT8 already have. rade_c also
// ships a fourth tool, real2iq, but RadeBridge deliberately doesn't use it
// (a batch, whole-file tool — see rade-bridge.js's own doc comment and
// docs/ui-notes.md's "Real bug found" note), so there's no env var for it.
const RADE_TX_BIN = process.env.RADE_TX_BIN || 'radae_tx';
const RADE_RX_BIN = process.env.RADE_RX_BIN || 'radae_rx';
const LPCNET_DEMO_BIN = process.env.LPCNET_DEMO_BIN || 'lpcnet_demo';
// Must match on both ends of a link, same as any modem. Defaults to 'v1':
// per rade_c's own README, V1 is undeprecated and documented as stable,
// while V2 is explicitly described as "under active development" with a
// waveform/model/API "subject to change without notice" and upstream
// itself says "on-air use is not recommended at this stage" for V2 — see
// docs/ui-notes.md. Set RADE_VERSION=v2 only if you specifically want to
// experiment with the newer V2 waveform, at your own risk per upstream.
const RADE_VERSION = process.env.RADE_VERSION === 'v2' ? 'v2' : 'v1';
// Linear gain applied to the real part extracted from radae_tx's complex
// IQ output before it's sent to the radio (see rade-bridge.js's own
// txGain doc comment) — a knob for the "little or no TX power in RADE
// mode" symptom, since nothing here has been checked against a real
// signal/power meter. Defaults to 4, not 1 (i.e. not just trusting
// radae_tx's own unmodified output level) — a remote station reported
// only ~20% modulation at the full-scale-but-no-extra-gain level this
// bridge otherwise sends (see docs/ui-notes.md's "Real bug found" note),
// so 4 is a real-world-informed correction, deliberately short of the
// 5x a literal "scale 20% up to 100%" calculation would suggest, to
// leave some headroom against clipping the OFDM waveform's peaks (which
// typically run hotter than its average/ALC-read level). Set
// RADE_TX_GAIN explicitly to override — higher if drive still reads low
// on your own radio/audio chain, lower (down to below 1) if it now
// clips/distorts instead.
const RADE_TX_GAIN = (() => {
  const parsed = parseFloat(process.env.RADE_TX_GAIN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
})();

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '../client');

// Scope is opt-in: it adds continuous CI-V bus traffic once enabled
// (5-10Hz per Icom's own docs), and real-world reliability varies by
// radio/firmware/baud-rate — confirm with test/manual-scope-test.js
// before enabling this for real use. See docs/civ-notes.md.
const SCOPE_ENABLED = /^(1|true)$/i.test(process.env.CIV_SCOPE_ENABLED || '');

// Best-effort: forces the radio's own internal "AF output level to
// ACC/USB" and "MOD input level from USB" CI-V settings to maximum (255)
// once at startup — see maximizeUsbAudioLevelsOnRadio() below and
// docs/civ-notes.md. Distinct from (and in addition to) AudioBridge's
// own ALSA-side `amixer` maximization (docs/audio-notes.md): that one
// maximizes the Linux-side USB codec controls; this maximizes the
// radio's own internal level for the same signal path. Set to "0"/
// "false" to skip this and leave the radio's levels as found.
const CIV_MAXIMIZE_USB_LEVELS = !/^(0|false)$/i.test(process.env.CIV_MAXIMIZE_USB_LEVELS || '1');

// TLS is optional but strongly recommended: without it, microphone access
// (getUserMedia) is unavailable in the browser entirely on any origin
// other than localhost, which breaks PTT/TX audio when accessed over the
// LAN by IP/hostname. See docs/pwa-notes.md for cert generation options.
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;

let civ;
let controlServer;
let audioBridge;
let scopeBridge;
let cwDecoderBridge;
let rttyDecoderBridge;
let ft8Bridge;
let radeBridge;
let freeDvReporterBridge;

/**
 * Best-effort: forces the radio's own "AF output level to ACC/USB"
 * (CI-V 1A 05 00 60) and "MOD input level from USB" (1A 05 00 65) to
 * maximum (255) once at startup, then reads each back to confirm and log
 * what the radio actually reports — see CivDriver#setAfOutputLevelUsb()/
 * setModInputLevelUsb() for the full byte-layout reasoning. Given
 * directly by the operator from a real IC-7300 (address and a worked
 * "set to max" example), same as DATA MODE's address was before it —
 * see docs/civ-notes.md.
 *
 * Same rationale as AudioBridge's own ALSA-side `amixer` maximization
 * (docs/audio-notes.md), applied to the other half of the same audio
 * path: a predictable, repeatable level rather than whatever a previous
 * session or the radio's own power-on default happened to leave these
 * at. Deliberately best-effort and non-fatal — an older
 * firmware/model that doesn't support this parameter, or any other CI-V
 * error, is logged and otherwise ignored rather than blocking server
 * startup, the same tolerance the ALSA-side equivalent already has.
 */
async function maximizeUsbAudioLevelsOnRadio(civ) {
  try {
    await civ.setAfOutputLevelUsb(255);
    const afLevel = await civ.getAfOutputLevelUsb();
    console.log(`[civ] AF output level to ACC/USB set to max (radio now reports: ${afLevel}/255)`);
  } catch (err) {
    console.log(`[civ] Could not set AF output level to ACC/USB (ignored): ${err.message}`);
  }

  try {
    await civ.setModInputLevelUsb(255);
    const modLevel = await civ.getModInputLevelUsb();
    console.log(`[civ] MOD input level from USB set to max (radio now reports: ${modLevel}/255)`);
  } catch (err) {
    console.log(`[civ] Could not set MOD input level from USB (ignored): ${err.message}`);
  }
}

async function main() {
  const radioAddr = RADIO_MODEL ? KNOWN_RADIO_ADDR[RADIO_MODEL] : undefined;
  civ = new CivDriver({ path: SERIAL_PATH, radioAddr, baudRate: CIV_BAUD_RATE });

  civ.on('error', (err) => console.error('[civ error]', err.message));

  await civ.open();
  console.log(`CI-V port open: ${SERIAL_PATH} at ${civ.baudRate} baud`);

  if (!civ.radioAddr) {
    console.log('No radio address configured; attempting auto-detect...');
    const addr = await civ.detectRadioAddress();
    console.log(`Detected radio at CI-V address 0x${addr.toString(16)}`);
  } else {
    console.log(`Using configured radio address 0x${civ.radioAddr.toString(16)}`);
  }

  if (CIV_MAXIMIZE_USB_LEVELS) {
    await maximizeUsbAudioLevelsOnRadio(civ);
  } else {
    console.log('CIV_MAXIMIZE_USB_LEVELS=0; leaving the radio\'s own USB audio levels as found.');
  }

  let tls = null;
  if (TLS_CERT_PATH && TLS_KEY_PATH) {
    tls = {
      cert: fs.readFileSync(TLS_CERT_PATH),
      key: fs.readFileSync(TLS_KEY_PATH),
    };
  } else if (TLS_CERT_PATH || TLS_KEY_PATH) {
    throw new Error('Both TLS_CERT_PATH and TLS_KEY_PATH must be set together (only one was provided)');
  }

  controlServer = new ControlServer({
    civ,
    port: WS_PORT,
    staticDir: STATIC_DIR,
    tls,
    screenTitle: SCREEN_TITLE,
    appVersion: APP_VERSION,
    stationCallsign: STATION_CALLSIGN,
    stationGrid: STATION_GRID,
    rnnoiseLevelCount: RNNOISE_LEVEL_COUNT,
    sourceCodeUrl: SOURCE_CODE_URL,
  });
  const boundPort = await controlServer.listen();
  const scheme = tls ? 'https' : 'http';
  console.log(`Control server listening on ${scheme}://0.0.0.0:${boundPort}`);
  console.log(`Serving PWA app shell from ${STATIC_DIR}`);
  if (!tls) {
    console.log(
      'TLS not configured (TLS_CERT_PATH/TLS_KEY_PATH unset) — microphone access will not ' +
        'work over the LAN except from localhost. See docs/pwa-notes.md.'
    );
  }

  // FreeDV Reporter has no dependency on AudioBridge — unlike RADE, it
  // doesn't touch audio at all, just the FreeDV chip's armed/variant
  // state, PTT, and frequency (all available regardless of whether this
  // server instance even has AUDIO_RX_DEVICE configured) — see
  // src/server/freedv-reporter.js.
  if (FREEDV_REPORTER_ENABLED) {
    freeDvReporterBridge = new FreeDvReporterBridge({
      controlServer,
      callsign: STATION_CALLSIGN,
      gridSquare: STATION_GRID,
      // Reported verbatim as this station's client version — set to
      // match this project's own naming ("PiRO", see SCREEN_TITLE's
      // default) plus the FreeDV protocol/waveform version it's
      // interoperable with, per explicit request, rather than this
      // project's own package.json version (which FreeDV Reporter has no
      // reason to recognize).
      version: 'PiRO - FreeDV 2.4.0',
      radeVersion: RADE_VERSION,
      host: FREEDV_REPORTER_HOST,
    });
    freeDvReporterBridge.start();
    if (STATION_CALLSIGN && STATION_GRID) {
      console.log('FreeDV Reporter ready (reports to qso.freedv.org while the FreeDV chip is armed).');
    } else {
      console.log(
        'FreeDV Reporter enabled but STATION_CALLSIGN/STATION_GRID are not both set; reporting stays a no-op until they are.'
      );
    }
  } else {
    console.log('FREEDV_REPORTER_ENABLED=0; FreeDV Reporter disabled.');
  }

  if (AUDIO_RX_DEVICE) {
    audioBridge = new AudioBridge({
      controlServer,
      // Only ever used to pick which HamNoise model (CW vs. voice) is
      // loaded when the operator arms the "HamNoise" button — see
      // audio-bridge.js's own class doc comment and
      // _handleCivModeChange(). AudioBridge has no other use for `civ`.
      civ,
      rxDevice: AUDIO_RX_DEVICE,
      txDevice: AUDIO_TX_DEVICE,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      codecType: AUDIO_CODEC,
      rnnoiseBin: RNNOISE_BIN,
      rnnoiseWetLevels: RNNOISE_WET_LEVELS,
      hamnoiseQuality: HAMNOISE_QUALITY,
    });
    await audioBridge.start();
    controlServer.setAudioInfo({
      enabled: true,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      codec: AUDIO_CODEC,
    });
    console.log(
      `Audio bridge started (rx: ${AUDIO_RX_DEVICE}, tx: ${AUDIO_TX_DEVICE}, ` +
        `${AUDIO_SAMPLE_RATE}Hz, ${AUDIO_CHANNELS}ch, codec: ${AUDIO_CODEC}, ` +
        `HamNoise quality: ${HAMNOISE_QUALITY})`
    );

    // CW decoding is a hard dependency on RX audio being configured
    // (it decodes from the same PCM stream audio playback uses), so it
    // only ever exists alongside an AudioBridge — no separate env var,
    // it self-activates automatically based on mode (CW) and PTT state,
    // per how it was actually requested. See docs/civ-notes.md and
    // docs/ui-notes.md.
    cwDecoderBridge = new CwDecoderBridge({ civ, controlServer, audioBridge });
    await cwDecoderBridge.start();
    console.log('CW decoder ready (activates automatically when mode is CW and not transmitting).');

    // RTTY decoding mirrors CW's own wiring exactly (same hard
    // dependency on AudioBridge, same automatic mode/PTT-driven
    // activation, no separate env var) — see rtty-decoder-bridge.js and
    // rtty-decoder.js for what's actually different (fixed 45.45 baud /
    // 170Hz-shift Baudot demod instead of adaptive Morse timing).
    rttyDecoderBridge = new RttyDecoderBridge({ civ, controlServer, audioBridge });
    await rttyDecoderBridge.start();
    console.log('RTTY decoder ready (activates automatically when mode is RTTY and not transmitting).');

    // FT8 RX/TX is likewise a hard dependency on AudioBridge (RX decode
    // reads the same PCM stream; TX playback reuses the same audio-out
    // path PTT/voice/CW paddle already use) — no separate env var.
    // Unlike CW, it doesn't self-activate from CI-V mode (the radio has
    // no native "FT8" mode; operators run it on USB — see
    // docs/ui-notes.md), so it stays idle until the client's FT8 panel
    // explicitly arms it via SET_FT8_ACTIVE.
    ft8Bridge = new Ft8Bridge({ civ, controlServer, audioBridge });
    ft8Bridge.start();
    console.log('FT8 bridge ready (RX decoding activates when a client opens the FT8 panel).');

    // RADE (FreeDV's neural-vocoder mode) is likewise a hard dependency
    // on AudioBridge — same reasoning as FT8 immediately above, since
    // it's also not a real CI-V mode. Unlike FT8, this doesn't decode
    // anything until the compiled rade_c binaries are actually reachable
    // on PATH (or via RADE_*_BIN, see above) — if they're missing, the
    // pipeline just fails to spawn and reports an audio-error the first
    // time it's actually used, rather than failing server startup over an
    // optional feature. See docs/ui-notes.md for install instructions and
    // this feature's "genuinely unverified" caveat.
    radeBridge = new RadeBridge({
      controlServer,
      audioBridge,
      txBin: RADE_TX_BIN,
      rxBin: RADE_RX_BIN,
      lpcnetBin: LPCNET_DEMO_BIN,
      radeVersion: RADE_VERSION,
      txGain: RADE_TX_GAIN,
    });
    radeBridge.start();
    console.log(
      `RADE bridge ready (RADE ${RADE_VERSION}; activates when a client's FreeDV mode is set to the ` +
        'RADE variant — 700E has no codec wired up, see docs/ui-notes.md).'
    );
  } else {
    console.log(
      'AUDIO_RX_DEVICE not set; audio pipeline disabled. ' +
        'Set it to e.g. AUDIO_RX_DEVICE=plughw:1,0 to enable (see `arecord -l` on the Pi).'
    );
  }

  if (SCOPE_ENABLED) {
    scopeBridge = new ScopeBridge({ civ, controlServer });
    try {
      await scopeBridge.start();
      controlServer.setScopeInfo({ enabled: true });
      console.log('Scope output enabled; broadcasting scope-line frames to clients.');
    } catch (err) {
      controlServer.setScopeInfo({ enabled: false });
      console.error(
        '[scope] Radio rejected the enable-scope commands:',
        err.message,
        '\n         Scope will stay disabled for this session. See docs/civ-notes.md.'
      );
    }
  } else {
    controlServer.setScopeInfo({ enabled: false });
    console.log('CIV_SCOPE_ENABLED not set; spectrum scope disabled.');
  }
}

async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  try {
    if (scopeBridge) await scopeBridge.stop();
    if (cwDecoderBridge) cwDecoderBridge.stop();
    if (rttyDecoderBridge) rttyDecoderBridge.stop();
    if (ft8Bridge) ft8Bridge.stop();
    if (radeBridge) radeBridge.stop();
    if (freeDvReporterBridge) freeDvReporterBridge.stop();
    if (audioBridge) audioBridge.stop();
    if (controlServer) await controlServer.close();
    if (civ) await civ.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
