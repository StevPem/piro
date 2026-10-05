import { RigLink } from './rpc.js';
import { AudioPipeline } from './audio.js';
import { ScopeDisplay } from './scope.js';
import { S_METER_LEVELS, sMeterLevelIndex, sMeterLabel } from './smeter.js';
import { rawToVswr, vswrZone } from './vswr.js';
import { Ft8QsoSequencer, isRelatedToQso, defaultCqMessage } from './ft8-qso.js';

// --- Service worker: only register in a secure context (https:, or
// http://localhost). See docs/pwa-notes.md for why plain http on a LAN
// address can't register one, and what that does/doesn't affect.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
} else if ('serviceWorker' in navigator) {
  console.info('Service worker not registered: not a secure context (see docs/pwa-notes.md).');
}

// --- Screen Wake Lock: keep the screen from dimming/locking while this
// page is open, so an operator mid-QSO on a phone isn't cut off by the
// phone's own screen timeout. Like the service worker above, this API is
// only available in a secure context (see docs/pwa-notes.md) — feature-
// detected the same way, and just as non-fatal to skip if unavailable:
// the app works fully normally either way, this is a convenience only.
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      // Fires both when *we* release it (we never do — the lock is meant
      // to hold for as long as the page is open) and when the browser
      // force-releases it on its own (tab/screen hidden, some browsers
      // also drop it on low battery). Either way, null it out so the
      // visibilitychange handler below knows there's nothing held and
      // asks again once the page is actually visible.
      wakeLock = null;
    });
  } catch (err) {
    // Most commonly NotAllowedError — e.g. the document isn't visible
    // yet at the moment of the request, or the platform declined it for
    // its own reasons (low battery on some browsers). Not worth an error
    // toast for a nice-to-have; the visibilitychange handler below will
    // simply try again next time the page becomes visible.
    console.info('Screen Wake Lock not acquired:', err.message);
  }
}

requestWakeLock();

// The browser automatically *releases* the lock whenever the page is
// hidden (another tab gets focus, the phone's screen is locked/turned
// off, the app is backgrounded) but does **not** automatically
// re-acquire it when the page becomes visible again — a fresh request is
// needed every time, which is what this does. Guarded by `!wakeLock` so
// it's a no-op if something else already holds a lock (shouldn't happen
// here, but requesting twice needlessly isn't harmful either way).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
});

// --- Data: band quick-tune points and mode list ---
// `hz` is a representative tuning point (convenience, not an attempt at
// authoritative band-plan edges — there's no separate "band" concept in
// CI-V itself). The scope always shows a fixed 250kHz centered on
// whatever frequency is tuned (set up once server-side — see
// ScopeBridge#start() — and kept centered automatically by the radio's
// own Center-mode behavior), so band selection doesn't need to touch the
// scope directly; it just needs to retune the VFO.
const BANDS = [
  { name: '160m', hz: 1900000 },
  { name: '80m', hz: 3750000 },
  { name: '40m', hz: 7150000 },
  { name: '30m', hz: 10125000 },
  { name: '20m', hz: 14175000 },
  { name: '17m', hz: 18100000 },
  { name: '15m', hz: 21200000 },
  { name: '12m', hz: 24930000 },
  { name: '10m', hz: 28400000 },
  { name: '6m', hz: 50125000 },
];

// Must exactly match keys in src/civ/commands.js MODE — the server passes
// this string straight through to CivDriver.setMode().
const MODES = ['LSB', 'USB', 'AM', 'CW', 'RTTY', 'FM'];

// The mode-row chip order actually rendered — laid out as two rows of
// four (see the .chips--grid-4 rule in styles.css and the "modes" element
// in index.html): real hardware voice/CW modes on top, and the "requires
// external decoding/encoding" modes (CW's live ticker aside) on the
// bottom row. RTTY's chip was removed for a while (its UI slot was given
// to FT8) but has since been restored alongside FT8, at the user's
// request — both now coexist as their own chips, and FreeDV joins them
// as a third app-level pseudo-mode. 'FT8' and 'FreeDV' are sentinels
// handled specially in the render loop below, not values ever sent to
// setMode — see FT8_FREQUENCIES' doc comment for why FT8 isn't a CI-V
// mode at all, and enterFreeDvMode()'s doc comment for the equivalent
// story for FreeDV. The FT8 chip is a toggle: a first click enters FT8
// (whichever of FT8/FT4 was last active, or FT8 the first time), a click
// while already active switches between the two protocols (see
// toggleFt8Variant()) — still just one chip/label, showing whichever
// variant is currently active ("FT8"/"FT4"). The FreeDV chip is not a
// toggle — it only ever operates as RADE V1 (see enterFreeDvMode()'s doc
// comment for why the earlier '700E'/'RADE' variant choice was removed),
// so a click just arms/disarms it, same as any ordinary hardware mode
// chip. 'RTTY', unlike 'FT8'/'FreeDV', is a perfectly ordinary CI-V hardware
// mode (see MODES above) — it needs no special-casing in the render loop
// at all, just the usual setMode plumbing every other real mode chip
// already has; see "RTTY decode" below for the automatic-on-mode-entry
// decoder ticker layered on top of it, the same pattern already used for
// CW.
const MODE_CHIPS = ['LSB', 'USB', 'AM', 'FM', 'CW', 'RTTY', 'FT8', 'FreeDV'];

// Standard FT8 calling/dial frequencies (USB dial, i.e. the frequency the
// radio is tuned to — the actual audio tone sits ~1-3kHz above this
// within the passband, per the encoder/decoder's own baseFrequency, not
// something this app needs to add on top when tuning the radio). These
// are the widely-used band-plan conventions (the same ones WSJT-X ships
// as defaults), not something this radio or CI-V defines — see
// docs/ui-notes.md. 6m has more regional variation than the others; 50.313
// is the common VK/US convention used here.
const FT8_FREQUENCIES = {
  '160m': 1840000,
  '80m': 3573000,
  '40m': 7074000,
  '30m': 10136000,
  '20m': 14074000,
  '17m': 18100000,
  '15m': 21074000,
  '12m': 24915000,
  '10m': 28074000,
  '6m': 50313000,
};

// Standard FT4 calling/dial frequencies — FT4 is a *different* protocol
// from FT8 (same underlying ft8ts library, but a faster 7.5s slot and its
// own waveform — see ft8-bridge.js), and per widely-used band-plan
// convention (again matching WSJT-X's own defaults) it does NOT share
// FT8's calling frequencies; each band's FT4 slot sits a few kHz away
// from that band's FT8 slot so the two protocols don't collide on the
// air. Verified against multiple independent band-plan references (not
// guessed) — see docs/ui-notes.md. 160m has no widely-adopted standard
// FT4 calling frequency (sources disagree or simply list none), so it's
// deliberately omitted here rather than guessed; entering FT4 mode on
// 160m just won't auto-tune, the same graceful fallback
// tuneFt8ToBand()/checkFt8BandChange() already have for any band missing
// from a frequency table.
const FT4_FREQUENCIES = {
  '80m': 3575000,
  '40m': 7047500,
  '30m': 10140000,
  '20m': 14080000,
  '17m': 18104000,
  '15m': 21140000,
  '12m': 24919000,
  '10m': 28180000,
  '6m': 50318000,
};

// Approximate amateur band edges, used only to classify "which band is
// this frequency in" so that a manual frequency change (typed in, or a
// scope click) while FT8 is active is still recognized as a band change
// and re-tuned to that band's FT8 frequency — not just clicks on the
// Band chips themselves. Deliberately generous/approximate (this isn't a
// band-plan compliance check, just enough to pick the right FT8 calling
// frequency) — see docs/ui-notes.md.
const BAND_RANGES = [
  { name: '160m', loHz: 1800000, hiHz: 2000000 },
  { name: '80m', loHz: 3500000, hiHz: 4000000 },
  { name: '40m', loHz: 7000000, hiHz: 7300000 },
  { name: '30m', loHz: 10100000, hiHz: 10150000 },
  { name: '20m', loHz: 14000000, hiHz: 14350000 },
  { name: '17m', loHz: 18068000, hiHz: 18168000 },
  { name: '15m', loHz: 21000000, hiHz: 21450000 },
  { name: '12m', loHz: 24890000, hiHz: 24990000 },
  { name: '10m', loHz: 28000000, hiHz: 29700000 },
  { name: '6m', loHz: 50000000, hiHz: 54000000 },
];

function bandNameForFrequency(hz) {
  const band = BAND_RANGES.find((b) => hz >= b.loHz && hz <= b.hiHz);
  return band ? band.name : null;
}

// Scope span options — direct full-width values, matching all 8 of the
// radio's fixed span presets (see SCOPE_SPAN_PRESETS_HZ in
// src/civ/commands.js: 2.5/5/10/25/50/100/250/500 kHz). Confirmed
// against Icom's own official IC-7300 CI-V reference manual's "Span
// (kHz)" table — these are direct span widths, not "+/-" half-widths
// needing doubling (an earlier, less authoritative source claimed
// otherwise and was wrong; see docs/civ-notes.md for the full history).
const SPAN_OPTIONS = [
  { label: '2.5 kHz', spanHz: 2500 },
  { label: '5 kHz', spanHz: 5000 },
  { label: '10 kHz', spanHz: 10000 },
  { label: '25 kHz', spanHz: 25000 },
  { label: '50 kHz', spanHz: 50000 },
  { label: '100 kHz', spanHz: 100000, isDefault: true },
  { label: '250 kHz', spanHz: 250000 },
  { label: '500 kHz', spanHz: 500000 },
];

// Frequency step buttons flanking the frequency display.
const FREQ_STEPS = [
  { id: 'freq-step-down-10k', deltaHz: -10000 },
  { id: 'freq-step-down-1k', deltaHz: -1000 },
  { id: 'freq-step-up-1k', deltaHz: 1000 },
  { id: 'freq-step-up-10k', deltaHz: 10000 },
];

// RX function toggles rendered as dropdowns to the right of the band/mode
// chips. Each option's `value` is the exact value sent to the server
// (matched back up via the <select>'s index, not by string-converting the
// value — avoids boolean/number-vs-string mismatches from HTML <option>
// values always being strings). `request`/`paramName` match the
// WebSocket request type and its parameter name — see src/server/protocol.js.
const FUNCTION_CONTROLS = [
  {
    key: 'preamp',
    label: 'P.Amp',
    request: 'setPreamp',
    getRequest: 'getPreamp',
    paramName: 'value',
    options: [
      { shortLabel: 'Off', value: 0 },
      { shortLabel: '1', value: 1 },
      { shortLabel: '2', value: 2 },
    ],
  },
  {
    key: 'nr',
    label: 'NR',
    request: 'setNoiseReduction',
    getRequest: 'getNoiseReduction',
    paramName: 'on',
    options: [
      { shortLabel: 'Off', value: false },
      { shortLabel: 'On', value: true },
    ],
  },
  {
    key: 'notch',
    label: 'Notch',
    request: 'setNotch',
    getRequest: 'getNotch',
    paramName: 'on',
    options: [
      { shortLabel: 'Off', value: false },
      { shortLabel: 'On', value: true },
    ],
  },
  {
    key: 'filter',
    label: 'Filter',
    request: 'setFilter',
    getRequest: 'getFilter',
    paramName: 'value',
    options: [
      { shortLabel: '1', value: 1 },
      { shortLabel: '2', value: 2 },
      { shortLabel: '3', value: 3 },
    ],
  },
];

// Transmit power presets — CivDriver#setTxPower() converts watts to the
// radio's raw 0-255 level via a linear assumption (see its doc comment
// in driver.js for the honest caveat on this not being independently
// hardware-confirmed).
const TX_POWER_OPTIONS = [
  { label: '100W', watts: 100 },
  { label: '75W', watts: 75 },
  { label: '50W', watts: 50 },
  { label: '25W', watts: 25 },
  { label: '5W', watts: 5 },
];

// --- DOM refs ---
const panelTitleEl = document.querySelector('.panel__title');
const appVersionEl = document.getElementById('app-version');
const appSourceLinkEl = document.getElementById('app-source-link');
const ledDot = document.getElementById('led-dot');
const ledText = document.getElementById('led-text');
const errorLine = document.getElementById('error-line');

const freqDisplay = document.getElementById('freq-display');
const freqInput = document.getElementById('freq-input');
const bandsEl = document.getElementById('bands');
const modesEl = document.getElementById('modes');

const meterValue = document.getElementById('meter-value');
const meterBarEl = document.getElementById('meter-bar');

const speakerBtn = document.getElementById('speaker-btn');
const tunerBtn = document.getElementById('tuner-btn');
const tuneBtn = document.getElementById('tune-btn');
const txPowerSelect = document.getElementById('tx-power-select');
const rxGainSlider = document.getElementById('rx-gain-slider');
const pttBtn = document.getElementById('ptt-btn');
const pttHintEl = document.getElementById('ptt-hint');
const cwPaddleEl = document.getElementById('cw-paddle');
const cwDotBtn = document.getElementById('cw-dot-btn');
const cwDashBtn = document.getElementById('cw-dash-btn');
const cwWpmInput = document.getElementById('cw-wpm-input');
const cwTickerSectionEl = document.getElementById('cw-ticker-section');
const cwTickerEl = document.getElementById('cw-ticker');
const cwTickerTextEl = document.getElementById('cw-ticker-text');
const rttyTickerSectionEl = document.getElementById('rtty-ticker-section');
const rttyTickerEl = document.getElementById('rtty-ticker');
const rttyTickerTextEl = document.getElementById('rtty-ticker-text');
const scopeSection = document.getElementById('scope-section');
const scopePlaceholder = document.getElementById('scope-placeholder');
const scopeTraceCanvas = document.getElementById('scope-trace');
const scopeWaterfallCanvas = document.getElementById('scope-waterfall');
const scopeRangeLo = document.getElementById('scope-range-lo');
const scopeRangeHi = document.getElementById('scope-range-hi');
const scopeAxisEl = document.getElementById('scope-axis');
const scopeSpansEl = document.getElementById('scope-spans');

const functionControlsEl = document.getElementById('function-controls');

const pttSectionEl = document.querySelector('.ptt-section');
const ft8PanelEl = document.getElementById('ft8-panel');
const ft8SlotTimeEl = document.getElementById('ft8-slot-time');
const ft8TableBodyEl = document.getElementById('ft8-table-body');
const ft8PanelLabelEl = document.getElementById('ft8-panel-label');
const ft8ComposerInput = document.getElementById('ft8-composer-input');
const ft8SendBtn = document.getElementById('ft8-send-btn');
const ft8StatusEl = document.getElementById('ft8-status');
const freeDvReportSectionEl = document.getElementById('freedv-report-section');
const freeDvMessageInput = document.getElementById('freedv-message-input');
const freeDvMessageSetBtn = document.getElementById('freedv-message-set-btn');
const freeDvReportStatusEl = document.getElementById('freedv-report-status');
const ft8QsoStatusEl = document.getElementById('ft8-qso-status');

const freqStepButtonEls = {
  'freq-step-down-10k': document.getElementById('freq-step-down-10k'),
  'freq-step-down-1k': document.getElementById('freq-step-down-1k'),
  'freq-step-up-1k': document.getElementById('freq-step-up-1k'),
  'freq-step-up-10k': document.getElementById('freq-step-up-10k'),
};

// --- State ---
let currentFreqHz = null;
// The radio's actual current CI-V mode (e.g. 'LSB', 'USB', 'CW'...),
// tracked here so band changes can tell whether sideband needs
// correcting — see the band-chip click handler below. Kept in sync by
// updateModeButtons(), the one function every mode-setting path already
// funnels through (the click handler here, the 'mode' broadcast
// listener, the initial 'connected' snapshot, and FT8/FreeDV's own
// sideband-setting code).
let currentMode = null;
let audioPipeline = null;
let pttActive = false;
let meterPollTimer = null;
let functionPollTimer = null;
let errorClearTimer = null;
let scopeEnabled = false;
let hasRequestedDefaultSpan = false; // auto-request the default span exactly once per page load — never on reconnect, so it can't clobber a manual selection made since; also decoupled from server startup entirely, see docs/civ-notes.md for why span-setting isn't attempted server-side at boot

// --- FT8 state ---
// ft8Active mirrors what's been told to the server via setFt8Active — it
// isn't a CI-V mode (the radio only ever sees USB; see FT8_FREQUENCIES'
// doc comment above and docs/ui-notes.md), so it's tracked independently
// of updateModeButtons()'s hardware-mode bookkeeping.
let ft8Active = false;
let ft8LastBandName = null; // which band FT8's auto-tune last targeted, to detect a *new* band change rather than re-tuning on every frequency update
let ft8SendInFlight = false;

// Which protocol the (repurposed) FT8 mode button currently drives —
// 'FT8' or 'FT4'. Mirrors the server's own controlServer.state.ft8Variant
// (see ws-server.js/ft8-bridge.js#setVariant) — kept in sync the same
// "broadcast, don't assume" way as psk-spot-enabled, mode, etc. (see the
// 'ft8-variant' listener and 'connected' handler below).
let ft8Variant = 'FT8';

// Which CW decoding algorithm the (repurposed) CW mode chip's label
// shows and the server-side ticker actually uses — 'CW1' (this app's
// original cw-decoder.js), 'CW2' (hamfist-cw-decoder.js, a port of the
// FFT/multi-channel "Hamfist" decoder), or 'CW3' (deepcw-decoder.js, a
// neural-network/CTC decoder ported from e04/deepcw-engine — decodes in
// bursts every several seconds rather than live character-by-character).
// Mirrors the server's own controlServer.state.cwDecoderVariant (see
// ws-server.js/cw-decoder-bridge.js) — kept in sync the same "broadcast,
// don't assume" way as ft8Variant above (see the 'cw-decoder-variant'
// listener and 'connected' handler below).
let cwDecoderVariant = 'CW1';

/** The calling-frequency table for whichever protocol is currently active. */
function ft8FrequencyTable() {
  return ft8Variant === 'FT4' ? FT4_FREQUENCIES : FT8_FREQUENCIES;
}

// Standard amateur SSB sideband convention: LSB below 10MHz (160m/80m/40m),
// USB at/above (30m and up). Used for FreeDV (see enterFreeDvMode()),
// which is operated as an ordinary SSB voice mode from the radio's point
// of view. Deliberately NOT used for FT8/FT4 (see enterFt8Mode()'s doc
// comment) — by long-standing convention, WSJT-X-style digital modes are
// always run on USB regardless of band, unlike voice SSB.
const SIDEBAND_SPLIT_HZ = 10_000_000;
function sidebandForFrequency(hz) {
  return hz < SIDEBAND_SPLIT_HZ ? 'LSB' : 'USB';
}

/**
 * Updates every bit of UI that shows the active protocol's name/label.
 * The mode chip itself only shows the specific variant ("FT8"/"FT4")
 * while FT8 mode is actually active — otherwise it reverts to the
 * neutral "FT8/FT4" label, so a glance at the unselected mode row shows
 * what the chip *does* rather than freezing on whichever protocol was
 * last selected. The FT8 panel label isn't affected by this (it's only
 * ever visible while FT8 mode is active in the first place, so there's
 * no "unselected" state for it to revert from).
 */
function updateFt8VariantUi() {
  if (ft8ModeBtn) ft8ModeBtn.textContent = ft8Active ? ft8Variant : 'FT8/FT4';
  if (ft8PanelLabelEl) ft8PanelLabelEl.textContent = `${ft8Variant} band activity`;
}

/**
 * Keeps the CW mode chip's label showing which decoder algorithm is
 * selected — "CW 1" (this app's original decoder), "CW 2" (the Hamfist
 * port), or "CW 3" (the DeepCW neural-network port) — regardless of
 * whether CW mode is actually active right now. Unlike the FT8 chip's
 * "neutral label when unselected" convention (there's no fourth, bare
 * "CW" state to revert to here — the whole point of repurposing this
 * chip's click cycle is to show which variant the next click will
 * (re-)enter), so the label always reflects cwDecoderVariant.
 */
function updateCwVariantUi() {
  if (cwModeBtn) {
    cwModeBtn.textContent = cwDecoderVariant === 'CW2' ? 'CW 2' : cwDecoderVariant === 'CW3' ? 'CW 3' : 'CW 1';
  }
}

/** CW1 -> CW2 -> CW3 -> CW1 — see updateCwVariantUi()'s doc comment. */
function nextCwDecoderVariant(variant) {
  if (variant === 'CW1') return 'CW2';
  if (variant === 'CW2') return 'CW3';
  return 'CW1';
}

// --- FreeDV state ---
// Like FT8/FT4, FreeDV isn't a CI-V hardware mode the IC-7300 knows
// about — it's a digital voice codec that runs in software reading/
// writing the radio's USB audio interface, with the radio itself just
// sitting in USB + DATA MODE the same way it does for FT8 (see
// enterFreeDvMode()'s doc comment). So freeDvActive is tracked
// independently of updateModeButtons()'s hardware-mode bookkeeping,
// exactly like ft8Active above.
//
// There's a real server-side bridge behind this — src/server/rade-bridge.js
// shells out to the operator's own compiled rade_c binaries
// (radae_tx/radae_rx/lpcnet_demo) to actually encode/decode RADE audio
// against the live RX/TX stream, mirroring Ft8Bridge's own RX/TX wiring.
// See docs/ui-notes.md for the full story and this feature's "genuinely
// unverified" caveat (there's no way to test the actual binaries or real
// radio hardware from wherever this app's code gets written/reviewed).
//
// FreeDV originally offered a second, '700E' variant (Codec2-based, no
// codec ever wired up in this codebase) alongside 'RADE', toggled by a
// second click on this same chip — removed per explicit request, since
// 700E never did anything here anyway. The FreeDV chip is now a plain
// arm/disarm toggle, like any hardware mode chip, always meaning "RADE
// V1" (the server-side variant concept — controlServer.state.freeDvVariant,
// RadeBridge#_variant — still technically exists, now permanently
// defaulted to 'RADE' server-side, but the client no longer needs to pick
// or track it). Armed/idle state (freeDvActive) still isn't broadcast/
// synced across clients, mirroring FT8's own SET_FT8_ACTIVE precedent
// exactly (see ws-server.js).
let freeDvActive = false;

/**
 * Updates the FreeDV button label — "RADE V1" while active, the neutral
 * "FreeDV" otherwise (matching updateFt8VariantUi()'s own "only show the
 * specific protocol while actually selected" pattern). Unlike FT8, there's
 * no variant to reflect here any more — see this section's own doc
 * comment for why the earlier '700E'/'RADE' toggle was removed.
 */
function updateFreeDvVariantUi() {
  if (freeDvModeBtn) freeDvModeBtn.textContent = freeDvActive ? 'RADE V1' : 'FreeDV';
}

// The operator's own station identity (STATION_CALLSIGN/STATION_GRID env
// vars — see src/server/index.js), null until the "connected" snapshot
// arrives, and possibly permanently null if unconfigured. Drives the
// default "CQ {CALLSIGN} {MAIDENHEAD}" composer message and the guided
// QSO sequencer below — see docs/ui-notes.md.
let stationCallsign = null;
let stationGrid = null;

// Drives the guided FT8 QSO sequence — see src/client/ft8-qso.js for the
// full state machine this only wires up to the UI. Stays fully inactive
// (every method a no-op) until stationCallsign/stationGrid are both
// known.
const ft8Qso = new Ft8QsoSequencer();

// Audio offset (Hz within the FT8 passband) a fresh CQ or any other
// transmission with no more specific target (no active guided QSO, no
// manual spectrum click yet) goes out at. 1500Hz is the conventional
// mid-passband default most FT8 operators/software (WSJT-X et al.)
// actually use — kept in sync with the server's own
// DEFAULT_TX_BASE_FREQUENCY_HZ fallback (src/audio/ft8-bridge.js), though
// this app always sends an explicit freqHz once FT8 mode is active (see
// sendFt8Message()) rather than relying on that server-side fallback.
const DEFAULT_FT8_TX_FREQ_HZ = 1500;

// The operator's current "default" TX frequency for this browser session:
// starts at DEFAULT_FT8_TX_FREQ_HZ, but is updated (and *stays* updated)
// whenever the operator picks a different one by clicking the FT8 audio
// spectrum (see the ScopeDisplay's onAudioFrequencyClick below) — per the
// explicit request that a manually-chosen TX frequency persist within the
// session, rather than silently reverting to the hardcoded default the
// next time a QSO wraps up or a fresh CQ goes out. Reset only by
// reloading the page (this app keeps no state across page loads — see
// docs/ui-notes.md); a real per-install persistence layer (localStorage,
// a server-side setting) was deliberately not added for this, consistent
// with how every other in-session-only piece of UI state in this file
// already works.
let ft8DefaultTxFreqHz = DEFAULT_FT8_TX_FREQ_HZ;

// The audio frequency (Hz within the passband) the *next* FT8
// transmission should actually go out at — see sendFt8Message() and
// docs/ui-notes.md's "TX/RX frequency" note. Sourced from, in order of
// precedence: the guided sequence's current suggestion
// (applyFt8Suggestion(), tracking the other station), a manual click on
// the FT8 audio spectrum (ScopeDisplay's onAudioFrequencyClick below,
// which also updates ft8DefaultTxFreqHz — see above), or, absent either,
// ft8DefaultTxFreqHz itself. Effectively never null while FT8 mode is
// active (enterFt8Mode() below seeds it from ft8DefaultTxFreqHz
// immediately) — null only before FT8 mode has ever been entered, when
// there's nothing to mark on the audio spectrum yet.
let currentQsoFreqHz = null;

// --- Connection ---
const link = new RigLink();
link.addEventListener('audio-frame', (event) => {
  if (audioPipeline) audioPipeline.playChunk(event.detail);
});

const scopeDisplay = new ScopeDisplay({
  traceCanvas: scopeTraceCanvas,
  waterfallCanvas: scopeWaterfallCanvas,
  onRangeUpdate: ({ lo, hi, divisions, audio }) => {
    if (audio) {
      // Audio-domain FFT spectrum (FT8): plain Hz, 0 = dial frequency —
      // an RF MHz reading would be meaningless here. See docs/ui-notes.md.
      scopeRangeLo.textContent = `${Math.round(lo)} Hz`;
      scopeRangeHi.textContent = `${Math.round(hi)} Hz`;
      renderScopeAxis(divisions, lo, hi, true);
      // The span slider is RF-only and already hidden while FT8 is active.
      return;
    }
    scopeRangeLo.textContent = `${(lo / 1e6).toFixed(3)} MHz`;
    scopeRangeHi.textContent = `${(hi / 1e6).toFixed(3)} MHz`;
    renderScopeAxis(divisions, lo, hi, false);
    updateSpanSliderFromRange(lo, hi);
  },
  onFrequencyClick: (hz) => {
    link
      .request('setFrequency', { value: hz })
      .then(() => updateFrequencyDisplay(hz))
      .catch((err) => showError(err.message));
  },
  onAudioFrequencyClick: (hz) => {
    // Clicking the FT8 audio spectrum picks the TX frequency for the
    // *next* transmission directly, the same way engaging a decoded CQ
    // does (see applyFt8Suggestion()) — marked with the same amber
    // marker via setQsoFreq() so there's exactly one visual language for
    // "this is where the next transmission is going out". Doesn't touch
    // the composer text or the guided-QSO status line: this is purely a
    // frequency choice, independent of (and overridable by) the guided
    // sequence engaging a real QSO afterwards.
    currentQsoFreqHz = hz;
    // Also persists as the new session default (see ft8DefaultTxFreqHz's
    // doc comment) — a manual pick should stick around as "where my CQs
    // go out" for the rest of the session, not just for one transmission.
    ft8DefaultTxFreqHz = hz;
    scopeDisplay.setQsoFreq(hz);
  },
});
link.addEventListener('scope-line', (event) => {
  if (ft8Active) return; // audio-domain FFT spectrum takes over the display; see the 'ft8-spectrum' listener below
  scopeDisplay.pushLine(event.detail);
});
link.addEventListener('ft8-spectrum', (event) => {
  if (!ft8Active) return;
  scopeDisplay.pushAudioSpectrum(event.detail);
});

/** Renders the division tick labels below the scope canvases (50kHz RF grid, or whole-Hz for the FT8 audio spectrum). */
function renderScopeAxis(divisions, lo, hi, audio = false) {
  scopeAxisEl.innerHTML = '';
  if (!divisions || !divisions.length || hi <= lo) return;
  for (const freq of divisions) {
    const pct = ((freq - lo) / (hi - lo)) * 100;
    const tick = document.createElement('div');
    tick.className = 'scope__tick';
    tick.style.left = `${pct}%`;
    tick.textContent = audio ? `${Math.round(freq)}` : (freq / 1e6).toFixed(3);
    scopeAxisEl.appendChild(tick);
  }
}
link.addEventListener('scope-error', (event) => showError(`Scope error: ${event.detail.message}`));
// Keeps the "PSK Spot" checkbox in sync when another connected client
// (or a page reload of this one) toggles it — same "broadcast, don't
// assume" pattern as data-mode, mode, etc. above.
link.addEventListener('psk-spot-enabled', (event) => {
  pskSpotCheckbox.checked = event.detail.enabled;
});
// Keeps the "FreeDV spot" checkbox in sync when another connected client
// (or a page reload of this one) toggles it — same pattern as
// psk-spot-enabled above.
link.addEventListener('freedv-spot-enabled', (event) => {
  freeDvSpotCheckbox.checked = event.detail.enabled;
});
// Keeps the RTTY "Reverse" checkbox in sync when another connected client
// (or a page reload of this one) toggles it — same pattern as
// psk-spot-enabled above.
link.addEventListener('rtty-reversed', (event) => {
  rttyReverseCheckbox.checked = event.detail.reversed;
});
// Keeps the "RNN" button in sync when another connected client (or a page
// reload of this one) changes its level — same pattern as psk-spot-enabled
// above.
link.addEventListener('rnnoise-level', (event) => {
  setRnnoiseButtonLevel(event.detail.level);
});
// Keeps the "HamNoise" button in sync when another connected client (or a
// page reload of this one) changes it — same pattern as rnnoise-level
// above. Also fires when AudioBridge itself forces HamNoise off because
// RNN was just armed (mutual exclusion — see server/audio-bridge.js's
// class doc comment), so this one listener covers both a direct click on
// this button and a side effect of clicking the other one.
link.addEventListener('hamnoise-enabled', (event) => {
  setHamNoiseButtonState(event.detail.enabled);
});
// Keeps the FT8/FT4 toggle in sync when another connected client changes
// it — same "broadcast, don't assume" pattern as psk-spot-enabled above.
// Only updates the label/local state here; doesn't re-tune (a remote
// client's toggle already re-tuned the shared radio frequency itself, and
// that arrives separately via the usual 'frequency' event).
link.addEventListener('ft8-variant', (event) => {
  ft8Variant = event.detail.variant;
  updateFt8VariantUi();
});
// Keeps the CW mode chip's label in sync when another connected client
// switches decoder variant — same "broadcast, don't assume" pattern as
// ft8-variant above.
link.addEventListener('cw-decoder-variant', (event) => {
  cwDecoderVariant = event.detail.variant;
  updateCwVariantUi();
});

function setLed(state, label) {
  ledDot.dataset.state = state;
  ledText.textContent = label;
}

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = false;
  clearTimeout(errorClearTimer);
  errorClearTimer = setTimeout(() => {
    errorLine.hidden = true;
  }, 5000);
}

link.addEventListener('connecting', () => setLed('connecting', 'Connecting\u2026'));

link.addEventListener('connected', (event) => {
  const data = event.detail || {};
  setLed('connected', 'Connected');

  if (data.screenTitle) {
    document.title = data.screenTitle;
    if (panelTitleEl) panelTitleEl.textContent = data.screenTitle;
  }
  // Small version number to the right of the title, matching the
  // "Connected" led text's size/color (.app-version reuses .led's
  // font-size) per explicit request — see docs/ui-notes.md.
  if (appVersionEl) appVersionEl.textContent = data.appVersion ? `v${data.appVersion}` : '';
  // AGPL-3.0-only §13 compliance link — see README.md's "Licence" section
  // and server/index.js's SOURCE_CODE_URL doc comment. Hidden entirely
  // (not just empty) when unset, same "hide, don't just blank" pattern
  // as other optional-feature UI elsewhere in this file.
  if (appSourceLinkEl) {
    if (data.sourceCodeUrl) {
      appSourceLinkEl.href = data.sourceCodeUrl;
      appSourceLinkEl.hidden = false;
    } else {
      appSourceLinkEl.hidden = true;
    }
  }
  // Static for the server's process lifetime, same as screenTitle — see
  // docs/ui-notes.md. Configuring the sequencer here (rather than only
  // once at page load) means a server restart with newly-set
  // STATION_CALLSIGN/STATION_GRID picks them up on the client's next
  // reconnect too, with no page reload needed.
  stationCallsign = data.stationCallsign || null;
  stationGrid = data.stationGrid || null;
  ft8Qso.configure({ myCall: stationCallsign, myGrid: stationGrid });
  if (data.frequency != null) updateFrequencyDisplay(data.frequency);
  if (data.mode) updateModeButtons(data.mode.mode);
  if (data.ptt != null) updatePttVisual(data.ptt);
  if (data.pskSpotEnabled != null) pskSpotCheckbox.checked = data.pskSpotEnabled;
  if (data.freeDvSpotEnabled != null) freeDvSpotCheckbox.checked = data.freeDvSpotEnabled;
  if (data.rttyReversed != null) rttyReverseCheckbox.checked = data.rttyReversed;
  // Rebuild the level list FIRST if the server's count differs (e.g. its
  // RNNOISE_WET env var has a different number of entries than the
  // default, or than before a server restart) — otherwise
  // setRnnoiseButtonLevel() below would clamp into a stale-sized array.
  if (data.rnnoiseLevelCount != null && data.rnnoiseLevelCount !== RNN_LEVELS.length) {
    RNN_LEVELS = buildRnnLevels(data.rnnoiseLevelCount);
  }
  if (data.rnnoiseLevel != null) setRnnoiseButtonLevel(data.rnnoiseLevel);
  if (data.hamNoiseEnabled != null) setHamNoiseButtonState(data.hamNoiseEnabled);
  // Restores whatever status message was last set (possibly by an
  // earlier connection) — see REQUEST.SET_FREEDV_MESSAGE's doc comment.
  if (data.freeDvMessage != null) freeDvMessageInput.value = data.freeDvMessage;
  if (data.ft8Variant) {
    ft8Variant = data.ft8Variant;
    updateFt8VariantUi();
  }
  if (data.cwDecoderVariant) {
    cwDecoderVariant = data.cwDecoderVariant;
    updateCwVariantUi();
  }
  // FreeDV no longer has a variant to reflect from the snapshot — it's
  // always RADE V1 now (see enterFreeDvMode()'s doc comment for why the
  // earlier '700E'/'RADE' toggle was removed).
  //
  // FT8/FreeDV "armed" state is a server-side setting, not anything the
  // radio itself reports over CI-V (see ws-server.js's own doc comments
  // on state.ft8Active/state.freeDvActive) — so unlike frequency/mode
  // above, a newly-connecting client only finds out about it from this
  // snapshot, not from any radio-driven event. Reflected here (after
  // frequency/variant are already applied above, since both reflect
  // functions read currentFreqHz/ft8Variant) rather than
  // re-armed from scratch — see reflectFt8ActiveFromServer()'s/
  // reflectFreeDvActiveFromServer()'s own doc comments for why calling
  // enterFt8Mode()/enterFreeDvMode() here instead would be wrong (it
  // would retune the radio and re-send requests for something already
  // active). Only ever set true here — never false, since ft8Active/
  // freeDvActive already start false and nothing above could have
  // changed that yet on this fresh page load.
  if (data.ft8Active) reflectFt8ActiveFromServer();
  if (data.freeDvActive) reflectFreeDvActiveFromServer();

  pttBtn.disabled = false;
  tunerBtn.disabled = false;
  tuneBtn.disabled = false;
  txPowerSelect.disabled = false;
  rxGainSlider.disabled = false;
  for (const btn of Object.values(freqStepButtonEls)) btn.disabled = false;
  for (const control of FUNCTION_CONTROLS) {
    if (control.buttonEl) control.buttonEl.disabled = false;
  }

  if (data.audio && data.audio.enabled) {
    if (!audioPipeline) {
      audioPipeline = new AudioPipeline({
        sampleRate: data.audio.sampleRate,
        channels: data.audio.channels,
        onMicFrame: (frame) => {
          if (pttActive) link.sendAudioFrame(frame);
        },
      });
    }
    speakerBtn.disabled = false;
    speakerBtn.title = '';
  } else {
    speakerBtn.disabled = true;
    speakerBtn.title = 'Audio is not configured on the server (AUDIO_RX_DEVICE unset)';
  }

  scopeEnabled = !!(data.scope && data.scope.enabled);
  if (scopeEnabled) {
    scopePlaceholder.hidden = true;
    scopeSpanSlider.disabled = false;
    // Server-side automatic span-setting at startup was tried twice and
    // failed both times for different reasons (see docs/civ-notes.md) —
    // span is deliberately requested from here instead, exactly once per
    // page load, well after server startup has already succeeded, so a
    // failure here can only affect this one request (shown as an error
    // toast), never anything else. Not re-requested on reconnect, so a
    // network blip can't silently reset a span another client chose since.
    if (!hasRequestedDefaultSpan) {
      hasRequestedDefaultSpan = true;
      const defaultOption = SPAN_OPTIONS.find((o) => o.isDefault) || SPAN_OPTIONS[0];
      requestScopeSpan(defaultOption);
    }
  } else {
    scopePlaceholder.hidden = false;
    scopePlaceholder.textContent = 'Spectrum scope not enabled on server (set CIV_SCOPE_ENABLED=true).';
  }

  startMeterPolling();
  startFunctionPolling();
});

link.addEventListener('close', () => {
  setLed('disconnected', 'Disconnected \u2014 retrying\u2026');
  stopMeterPolling();
  stopFunctionPolling();
});

link.addEventListener('frequency', (event) => updateFrequencyDisplay(event.detail.value));
link.addEventListener('mode', (event) => updateModeButtons(event.detail.value.mode));
link.addEventListener('ptt', (event) => updatePttVisual(event.detail.value));
// Fail-safe transmission cutoff (server-enforced — see docs/civ-notes.md).
// The 'ptt' event above already updates the button back to its released
// state; this just makes sure the operator understands *why* TX stopped,
// rather than it silently flipping off with no explanation.
link.addEventListener('ptt-timeout', (event) => {
  const minutes = Math.round((event.detail?.pttWatchdogMs ?? 600000) / 60000);
  showError(`Transmit automatically stopped after ${minutes} minutes (fail-safe cutoff).`);
});
// CW decode ticker — appends one character/word-space per event (see
// cw-decoder-bridge.js server-side) and keeps the view scrolled to the
// latest text, like a rolling terminal rather than a continuously
// re-animating marquee. The buffer is capped so a long CW session can't
// grow the DOM/string without bound.
const CW_TICKER_MAX_CHARS = 500;
link.addEventListener('cw-text', (event) => {
  const text = event.detail?.text;
  if (typeof text !== 'string') return;
  let updated = cwTickerTextEl.textContent + text;
  if (updated.length > CW_TICKER_MAX_CHARS) updated = updated.slice(updated.length - CW_TICKER_MAX_CHARS);
  cwTickerTextEl.textContent = updated;
  cwTickerEl.scrollLeft = cwTickerEl.scrollWidth;
});
// RTTY decode ticker — same rolling-terminal pattern as CW's above (one
// character per event, capped buffer, auto-scrolled), fed by
// rtty-decoder-bridge.js server-side. A decoded CR/LF (see
// src/audio/rtty-decoder.js's BAUDOT_TABLE) lands in the ticker text as a
// literal newline; `white-space: pre` isn't set on this element (it
// reuses `.cw-ticker__text`'s `nowrap`), so in practice it just renders
// as a space-like break rather than an actual visual line wrap — good
// enough for a rolling ticker, not trying to reproduce a real teletype's
// line semantics.
const RTTY_TICKER_MAX_CHARS = 500;
link.addEventListener('rtty-text', (event) => {
  const text = event.detail?.text;
  if (typeof text !== 'string') return;
  let updated = rttyTickerTextEl.textContent + text;
  if (updated.length > RTTY_TICKER_MAX_CHARS) updated = updated.slice(updated.length - RTTY_TICKER_MAX_CHARS);
  rttyTickerTextEl.textContent = updated;
  rttyTickerEl.scrollLeft = rttyTickerEl.scrollWidth;
});
link.addEventListener('rig-error', (event) => showError(`Rig error: ${event.detail.message}`));
link.addEventListener('audio-error', (event) => showError(`Audio error: ${event.detail.message}`));

link.connect();

// --- Frequency display/edit ---
function formatMHz(hz) {
  return (hz / 1e6).toFixed(6);
}

/**
 * Read-only display format, per explicit request: an extra "." after the
 * kHz group — "14.195.000" instead of formatMHz()'s plain "14.195000" —
 * so the kilohertz digits stand out from the single-hertz ones at a
 * glance. Only used for freqDisplay's non-editable text; beginFreqEdit()/
 * commitFreqEdit() still populate/parse the plain formatMHz() output for
 * the actual `<input>`, since a second "." would make the field's own
 * value unparseable as a number (`parseFloat("14.195.000")` stops at the
 * first ".", silently losing the kHz digits) the moment editing starts.
 */
function formatMHzGrouped(hz) {
  const [whole, frac] = formatMHz(hz).split('.');
  return `${whole}.${frac.slice(0, 3)}.${frac.slice(3)}`;
}

function updateFrequencyDisplay(hz) {
  currentFreqHz = hz;
  if (document.activeElement !== freqInput) {
    freqDisplay.textContent = formatMHzGrouped(hz);
  }
  scopeDisplay.setTunedFrequency(hz);
  updateBandButtons(hz);
  if (ft8Active) checkFt8BandChange(hz);
}

function beginFreqEdit() {
  freqInput.value = currentFreqHz != null ? formatMHz(currentFreqHz) : '';
  freqDisplay.hidden = true;
  freqInput.hidden = false;
  freqInput.focus();
  freqInput.select();
}

function commitFreqEdit() {
  const mhz = parseFloat(freqInput.value);
  freqInput.hidden = true;
  freqDisplay.hidden = false;
  if (!Number.isFinite(mhz) || mhz <= 0 || mhz > 100000) {
    showError('Enter a frequency in MHz, e.g. 14.195000');
    return;
  }
  const hz = Math.round(mhz * 1e6);
  link
    .request('setFrequency', { value: hz })
    .then(() => updateFrequencyDisplay(hz))
    .catch((err) => showError(err.message));
}

freqDisplay.addEventListener('click', beginFreqEdit);
freqInput.addEventListener('blur', commitFreqEdit);
freqInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') freqInput.blur();
  if (event.key === 'Escape') {
    freqInput.hidden = true;
    freqDisplay.hidden = false;
  }
});

// --- Frequency step buttons ---
function stepFrequency(deltaHz) {
  if (currentFreqHz == null) return; // nothing to step from yet
  // Per explicit request: stepping via the +/-1kHz or +/-10kHz buttons
  // always zeroes out anything below 1kHz resolution in the result,
  // rather than preserving whatever sub-kHz remainder currentFreqHz
  // happened to have (e.g. left over from a manual direct-entry edit, or
  // a digital mode like FT8 landing on an odd Hz offset). E.g. 1kHz up
  // from 14,210,250 Hz lands on 14,211,000 Hz, not 14,211,250 Hz — the
  // step is applied first, then the whole result is floored to the
  // nearest kHz, not just currentFreqHz beforehand, so this also doubles
  // as a one-press way to clean up an already-off-grid frequency.
  const newFreq = Math.floor((currentFreqHz + deltaHz) / 1000) * 1000;
  if (newFreq <= 0) return;
  link
    .request('setFrequency', { value: newFreq })
    .then(() => updateFrequencyDisplay(newFreq))
    .catch((err) => showError(err.message));
}
for (const step of FREQ_STEPS) {
  freqStepButtonEls[step.id].addEventListener('click', () => stepFrequency(step.deltaHz));
}

// --- Bands ---
// The server broadcasts frequency changes to *other* clients only (the
// assumption being the requester updates itself from its own request's
// result) — so we must apply the update locally here too, rather than
// only reacting to the 'frequency' event, or our own display lags.
const bandButtons = new Map();
for (const band of BANDS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = band.name;
  btn.addEventListener('click', () => {
    // While FT8 is active, a band chip means "go to this band's FT8
    // calling frequency", not the usual quick-tune point — see
    // FT8_FREQUENCIES above and tuneFt8ToBand() below.
    if (ft8Active && ft8FrequencyTable()[band.name] != null) {
      tuneFt8ToBand(band.name);
      return;
    }
    link
      .request('setFrequency', { value: band.hz })
      .then(() => {
        updateFrequencyDisplay(band.hz);
        // Plain SSB voice (and FreeDV, which rides on LSB/USB too — see
        // sidebandForFrequency()'s doc comment) needs its sideband
        // re-checked on every band change, not just when the mode is
        // first selected: switching bands while already sitting in
        // LSB/USB doesn't touch the mode, so nothing else re-evaluates
        // it. FT8/FT4 are deliberately excluded (see tuneFt8ToBand()).
        if (currentMode === 'LSB' || currentMode === 'USB') {
          const sideband = sidebandForFrequency(band.hz);
          if (sideband !== currentMode) {
            link
              .request('setMode', { mode: sideband })
              .then(() => updateModeButtons(sideband))
              .catch((err) => showError(`Couldn't set ${sideband} for ${band.name}: ${err.message}`));
          }
        }
      })
      .catch((err) => showError(err.message));
  });
  bandsEl.appendChild(btn);
  bandButtons.set(band.name, btn);
}

// Highlights whichever band chip matches the *actually observed* current
// frequency (via bandNameForFrequency(), the same lookup used for FT8
// band-change detection above) — same principle as updateModeButtons()/
// updateSpanSliderFromRange(): reflect confirmed state, not just "which
// chip was last clicked" (e.g. a frequency change from the freq-step
// buttons, a scope click, or another client should also move the
// highlight). A frequency outside every band's range (or not yet known)
// clears the highlight entirely, matching how no mode chip is active
// before the first mode report arrives.
function updateBandButtons(hz) {
  const name = hz != null ? bandNameForFrequency(hz) : null;
  for (const [bandName, btn] of bandButtons) {
    btn.classList.toggle('chip--active', bandName === name);
  }
}

// --- Modes ---
// Rendered from MODE_CHIPS (real hardware modes plus the 'FT8' sentinel
// — see its doc comment above), one shared loop so FT8 sits in the grid
// exactly like any other mode chip, same class, same active-state
// styling. FT8 isn't a CI-V mode (see FT8_FREQUENCIES' doc comment) —
// selecting it puts the radio on USB and arms RX/TX instead of calling
// setMode with 'FT8' (which the radio has no concept of) — see
// enterFt8Mode()/exitFt8Mode(). RTTY, unlike FT8, needs none of this
// special-casing — it's an ordinary entry that falls into the `else`
// branch below just like LSB/USB/AM/CW/FM.
const modeButtons = new Map();
let ft8ModeBtn = null;
let freeDvModeBtn = null;
let cwModeBtn = null;
for (const entry of MODE_CHIPS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = entry;

  if (entry === 'FT8') {
    ft8ModeBtn = btn;
    // Starts on the neutral "FT8/FT4" label, matching what
    // updateFt8VariantUi() reverts to once the mode is left — see its
    // doc comment. (ft8Active is false at page load, so this could also
    // be written as a call to updateFt8VariantUi() here, but the literal
    // string keeps this loop from depending on ft8ModeBtn already being
    // assigned to itself mid-assignment.)
    btn.textContent = 'FT8/FT4';
    btn.addEventListener('click', () => {
      // Explicitly picking FT8 always means "I'm not doing FreeDV right
      // now" — the two app-level pseudo-modes are mutually exclusive
      // (both just park the radio on USB + DATA MODE, so there's nothing
      // meaningful about "both at once"). See exitFreeDvMode()'s doc
      // comment.
      if (freeDvActive) exitFreeDvMode();
      // First click enters FT8/FT4 mode (whichever variant was last
      // active, or 'FT8' the first time); a click while already active
      // toggles the protocol instead — see toggleFt8Variant()'s doc
      // comment for why this is the more useful behavior than a second
      // click doing nothing or re-entering the same mode.
      if (!ft8Active) enterFt8Mode();
      else toggleFt8Variant();
    });
  } else if (entry === 'FreeDV') {
    freeDvModeBtn = btn;
    btn.addEventListener('click', () => {
      // Mutual exclusivity with FT8 — see the FT8 click handler's mirror
      // comment above.
      if (ft8Active) exitFt8Mode();
      // Unlike FT8, there's no second variant to toggle to any more (the
      // '700E' option was removed — see enterFreeDvMode()'s doc comment),
      // so a click while already active is simply a no-op.
      if (!freeDvActive) enterFreeDvMode();
    });
  } else if (entry === 'CW') {
    cwModeBtn = btn;
    // Starts labeled for whichever decoder variant is currently selected
    // (CW1 by default) — see updateCwVariantUi()'s doc comment for why,
    // unlike the FT8 chip, there's no neutral unselected label to fall
    // back to.
    updateCwVariantUi();
    btn.addEventListener('click', () => {
      if (ft8Active) exitFt8Mode();
      if (freeDvActive) exitFreeDvMode();
      // First click enters CW mode (using whichever decoder variant is
      // already selected); a click while CW mode is already active
      // cycles the variant (CW1 -> CW2 -> CW3 -> CW1) instead of
      // re-requesting the same mode — same "second click repurposed"
      // pattern as the FT8 chip's protocol toggle (see
      // toggleFt8Variant()'s doc comment).
      if (currentMode !== 'CW') {
        link
          .request('setMode', { mode: 'CW' })
          .then(() => updateModeButtons('CW'))
          .catch((err) => showError(err.message));
      } else {
        cwDecoderVariant = nextCwDecoderVariant(cwDecoderVariant);
        updateCwVariantUi();
        link
          .request('setCwDecoderVariant', { variant: cwDecoderVariant })
          .catch((err) => showError(`Couldn't switch CW decoder: ${err.message}`));
      }
    });
    modeButtons.set('CW', btn);
  } else {
    const mode = entry;
    btn.addEventListener('click', () => {
      // Explicitly picking a hardware mode always means "I'm not doing
      // FT8 or FreeDV right now" — see exitFt8Mode()'s/exitFreeDvMode()'s
      // doc comments for why this is the only way out of either
      // pseudo-mode (there's no CI-V signal for either one).
      if (ft8Active) exitFt8Mode();
      if (freeDvActive) exitFreeDvMode();
      link
        .request('setMode', { mode })
        .then(() => updateModeButtons(mode))
        .catch((err) => showError(err.message));
    });
    modeButtons.set(mode, btn);
  }

  modesEl.appendChild(btn);
}

function updateModeButtons(mode) {
  currentMode = mode;
  for (const [name, btn] of modeButtons) {
    btn.classList.toggle('chip--active', name === mode);
  }
  setCwPaddleVisible(mode === 'CW' && !ft8Active && !freeDvActive);
  setRttyTickerVisible(mode === 'RTTY' && !ft8Active && !freeDvActive);
}

// --- FT8 mode (app-level concept layered on USB — see docs/ui-notes.md) ---

/**
 * Puts the radio on USB, arms server-side FT8 RX decoding, auto-tunes to
 * the current band's FT8 calling frequency, and swaps the PTT
 * section/bandwidth control out for the FT8 band-activity panel. There's
 * no CI-V "FT8 mode" to key off of (see Ft8Bridge's own doc comment
 * server-side), so this is purely a client-side UI concept plus one
 * explicit setFt8Active request telling the server to start decoding.
 */
function enterFt8Mode() {
  ft8Active = true;
  ft8ModeBtn.classList.add('chip--active');
  setCwPaddleVisible(false);
  setRttyTickerVisible(false);
  setFt8UiVisible(true);

  // Starts every fresh FT8 session ready to call CQ — see
  // docs/ui-notes.md and ft8-qso.js's defaultCqMessage(). Only fills the
  // composer if it's currently empty, so re-entering FT8 mode (e.g.
  // briefly switching to CW and back) never clobbers text the operator
  // was already partway through composing. Silently stays empty if
  // STATION_CALLSIGN/STATION_GRID aren't configured server-side, exactly
  // as before this feature existed.
  if (!ft8ComposerInput.value) {
    ft8ComposerInput.value = defaultCqMessage(stationCallsign, stationGrid);
  }

  // Marks the session's current default TX frequency on the audio
  // spectrum immediately, before any decode/QSO/click has happened — so
  // the operator can see up front exactly where their first CQ is about
  // to go out (see ft8DefaultTxFreqHz's doc comment). Re-entering FT8
  // mode (e.g. briefly switching to CW and back) re-marks whatever the
  // session's current default is, not the hardcoded 1500Hz default, if
  // it was ever changed via a spectrum click earlier in the session.
  currentQsoFreqHz = ft8DefaultTxFreqHz;
  scopeDisplay.setQsoFreq(currentQsoFreqHz);

  // Swaps the chip's label from the neutral "FT8/FT4" to whichever
  // protocol is actually now active — see updateFt8VariantUi()'s doc
  // comment.
  updateFt8VariantUi();

  // FT8/FT4, unlike FreeDV, are NOT operated per the standard amateur
  // SSB LSB/USB-by-frequency convention — by long-standing convention
  // among WSJT-X-style digital modes, they're always run on USB
  // regardless of band (including on 160m/80m/40m, where voice SSB
  // would normally be LSB), precisely so a given audio-frequency offset
  // within the passband means the same RF frequency everywhere. See
  // sidebandForFrequency()'s doc comment for the (different) rule
  // FreeDV follows.
  link
    .request('setMode', { mode: 'USB' })
    .then(() => updateModeButtons('USB'))
    .catch((err) => showError(`Couldn't set USB for FT8: ${err.message}`));

  // USB alone is only the *operating* mode — it doesn't by itself route
  // this app's TX audio to the transmitter. The IC-7300 keeps a separate
  // "DATA MODE" toggle (CI-V 1A 05 00 63) with its own MOD-Input source
  // selection distinct from plain USB voice mode's — see
  // civ/driver.js#setDataMode's doc comment and docs/ui-notes.md for the
  // full story (including the one thing this CI-V command can't do: the
  // radio's own "MOD Input (DATA ON)" menu setting still has to actually
  // be set to USB by hand — CI-V has no way to change that remotely).
  link
    .request('setDataMode', { on: true })
    .catch((err) => showError(`Couldn't enable DATA MODE for FT8: ${err.message}`));

  link.request('setFt8Active', { active: true }).catch((err) => showError(`Couldn't start FT8 decoding: ${err.message}`));

  ft8LastBandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
  if (ft8LastBandName) tuneFt8ToBand(ft8LastBandName);
}

/**
 * Reflects an FT8/FT4 mode that's already armed server-side, per the
 * initial EVENT.CONNECTED snapshot's `ft8Active` field (this.state.ft8Active
 * — see ws-server.js) — i.e. FT8 was armed by an earlier connection from
 * this browser, or by a different client entirely, before this page
 * loaded. Deliberately does only the local UI bookkeeping enterFt8Mode()
 * does (chip highlight, FT8 panel visibility, hiding the CW paddle/RTTY
 * ticker) and none of its network side effects — no setMode/setDataMode/
 * setFt8Active request, and no auto-tuning to a calling frequency. All of
 * that already happened whenever FT8 was actually armed; re-doing it here
 * on every reconnect would retune the radio and needlessly re-arm
 * decoding that's already running, just to reflect state that was already
 * true. `ft8Variant`/`currentFreqHz` must already be set from the same
 * connect snapshot before this runs — see the 'connected' handler's call
 * order.
 */
function reflectFt8ActiveFromServer() {
  ft8Active = true;
  ft8ModeBtn.classList.add('chip--active');
  setCwPaddleVisible(false);
  setRttyTickerVisible(false);
  setFt8UiVisible(true);
  updateFt8VariantUi();
  ft8LastBandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
}

/** Leaves FT8 mode — called when the operator picks any real hardware mode. */
function exitFt8Mode() {
  if (!ft8Active) return;
  ft8Active = false;
  ft8ModeBtn.classList.remove('chip--active');
  // Reverts the chip's label back to the neutral "FT8/FT4" — see
  // updateFt8VariantUi()'s doc comment.
  updateFt8VariantUi();
  setFt8UiVisible(false);
  link.request('setFt8Active', { active: false }).catch((err) => showError(`Couldn't stop FT8 decoding: ${err.message}`));
  // Restore whatever MOD Input source the picked hardware mode expects
  // (typically the front-panel mic) — see enterFt8Mode()'s DATA MODE
  // comment for why this was turned on in the first place.
  link.request('setDataMode', { on: false }).catch((err) => showError(`Couldn't disable DATA MODE: ${err.message}`));
}

/**
 * Re-tunes to a given band's FT8/FT4 (whichever is active) calling
 * frequency and updates the tracked band. Deliberately does NOT touch
 * sideband — FT8/FT4 stay on USB on every band (see enterFt8Mode()'s doc
 * comment on why that's correct, unlike FreeDV/voice SSB).
 */
function tuneFt8ToBand(bandName) {
  const hz = ft8FrequencyTable()[bandName];
  if (hz == null) return;
  ft8LastBandName = bandName;
  link
    .request('setFrequency', { value: hz })
    .then(() => updateFrequencyDisplay(hz))
    .catch((err) => showError(`Couldn't tune to ${bandName} ${ft8Variant} frequency: ${err.message}`));
}

/**
 * Toggles the FT8 mode button between the FT8 and FT4 protocols — the
 * button is repurposed for this rather than adding a second button, per
 * the original request. Tells the server (setFt8Variant, handled by
 * Ft8Bridge#setVariant — re-grids its slot clock and switches
 * encode/decode functions) and immediately re-tunes to the new protocol's
 * calling frequency for whatever band is currently active, since FT8 and
 * FT4 do NOT share calling frequencies (see FT4_FREQUENCIES' doc
 * comment). Also resets the guided QSO sequencer and clears the
 * band-activity table: FT8 and FT4 use incompatible slot timing (15s vs
 * 7.5s), so a QSO step or decoded-message row from the protocol just left
 * behind has no meaning under the new one and would otherwise linger
 * looking like current activity.
 */
function toggleFt8Variant() {
  ft8Variant = ft8Variant === 'FT8' ? 'FT4' : 'FT8';
  updateFt8VariantUi();

  link.request('setFt8Variant', { variant: ft8Variant }).catch((err) => {
    showError(`Couldn't switch to ${ft8Variant}: ${err.message}`);
  });

  ft8TableBodyEl.innerHTML = '';
  ft8Qso.reset();
  hideQsoStatus();

  if (ft8LastBandName && ft8FrequencyTable()[ft8LastBandName] != null) {
    tuneFt8ToBand(ft8LastBandName);
  }
}

// --- FreeDV mode (app-level concept layered on USB — see docs/ui-notes.md) ---

/**
 * Puts the radio on USB + DATA MODE and marks the FreeDV button active.
 * There's no CI-V "FreeDV mode" any more than there's a CI-V "FT8
 * mode" — FreeDV is a digital voice codec that runs reading/writing the
 * radio's USB audio interface, with the radio itself just sitting in USB
 * + DATA MODE the same way it does for FT8 (see enterFt8Mode()'s DATA
 * MODE comment for the CI-V details, which apply identically here).
 *
 * Also arms the server-side bridge via setFreeDvActive — see
 * src/server/rade-bridge.js, which shells out to the operator's own
 * compiled rade_c binaries to actually encode/decode RADE audio against
 * the live RX/TX stream, so this is real (not just a UI toggle). No
 * swapped-out PTT section either way, since FreeDV is still operated as
 * an ordinary push-to-talk voice mode from this app's point of view
 * (unlike FT8). FreeDV originally also offered a '700E' variant
 * (Codec2-based, no codec ever wired up in this codebase) toggled by a
 * second click on this same chip — removed per explicit request, since
 * it never did anything here; this chip now only ever means RADE V1.
 */
function enterFreeDvMode() {
  freeDvActive = true;
  freeDvModeBtn.classList.add('chip--active');
  freeDvSpotLabel.hidden = false;
  freeDvReportSectionEl.hidden = false;
  updateFreeDvVariantUi();

  // FreeDV has no calling-frequency table/auto-tune (unlike FT8), so
  // sideband is simply based on wherever the radio is already sitting —
  // standard amateur SSB convention, LSB below 10MHz, USB at/above (see
  // sidebandForFrequency()'s doc comment).
  {
    const sideband = currentFreqHz != null ? sidebandForFrequency(currentFreqHz) : 'USB';
    link
      .request('setMode', { mode: sideband })
      .then(() => updateModeButtons(sideband))
      .catch((err) => showError(`Couldn't set ${sideband} for FreeDV: ${err.message}`));
  }

  link
    .request('setDataMode', { on: true })
    .catch((err) => showError(`Couldn't enable DATA MODE for FreeDV: ${err.message}`));

  link.request('setFreeDvActive', { active: true }).catch((err) => showError(`Couldn't arm FreeDV: ${err.message}`));
}

/**
 * Reflects a FreeDV mode that's already armed server-side, per the
 * initial EVENT.CONNECTED snapshot's `freeDvActive` field
 * (this.state.freeDvActive — see ws-server.js) — the same "already active
 * from an earlier connection or a different client" scenario
 * reflectFt8ActiveFromServer() handles for FT8; see its own doc comment
 * for why this deliberately skips every network side effect
 * enterFreeDvMode() normally triggers (setMode/setDataMode/
 * setFreeDvActive), doing only the local chip-highlight/visibility
 * bookkeeping.
 */
function reflectFreeDvActiveFromServer() {
  freeDvActive = true;
  freeDvModeBtn.classList.add('chip--active');
  freeDvSpotLabel.hidden = false;
  freeDvReportSectionEl.hidden = false;
  updateFreeDvVariantUi();
}

/** Leaves FreeDV mode — called when the operator picks any real hardware mode, or FT8. */
function exitFreeDvMode() {
  if (!freeDvActive) return;
  freeDvActive = false;
  freeDvModeBtn.classList.remove('chip--active');
  freeDvSpotLabel.hidden = true;
  freeDvReportSectionEl.hidden = true;
  // Reverts the chip's label back to the neutral "FreeDV" — see
  // updateFreeDvVariantUi()'s doc comment.
  updateFreeDvVariantUi();
  // Restore whatever MOD Input source the picked hardware mode expects
  // (typically the front-panel mic) — see enterFreeDvMode()'s DATA MODE
  // comment for why this was turned on in the first place.
  link.request('setDataMode', { on: false }).catch((err) => showError(`Couldn't disable DATA MODE: ${err.message}`));
  link.request('setFreeDvActive', { active: false }).catch((err) => showError(`Couldn't disarm FreeDV: ${err.message}`));
}

/**
 * Detects a band change while FT8 is active — whether from a manual
 * frequency edit, a scope click, or an unsolicited radio-side change —
 * and re-tunes to the new band's FT8 frequency, per "when changing
 * bands" in the original request. ft8LastBandName is updated by
 * tuneFt8ToBand() itself before its request resolves, so the frequency
 * update this triggers is recognized as "already the target band" and
 * doesn't loop.
 */
function checkFt8BandChange(hz) {
  const bandName = bandNameForFrequency(hz);
  if (bandName && bandName !== ft8LastBandName && ft8FrequencyTable()[bandName] != null) {
    tuneFt8ToBand(bandName);
  } else if (bandName) {
    ft8LastBandName = bandName;
  }
}

/**
 * Swaps the PTT section out for the FT8 band-activity panel, and hides
 * the bandwidth (Filter) control, which doesn't apply to a fixed-shape
 * FT8 signal — per "removing unnecessary items such as the bandwidth
 * buttons, and the PTT button" in the original request. The scope span
 * row is hidden too (the RF span buttons are meaningless once the
 * display switches to the audio-domain FT8 spectrum — see the
 * 'ft8-spectrum'/'scope-line' listener wiring above and
 * docs/ui-notes.md — which server-side FFT logic in
 * src/audio/ft8-bridge.js drives independently of any RF scope span).
 */
function setFt8UiVisible(active) {
  ft8PanelEl.hidden = !active;
  pttSectionEl.hidden = active;

  const filterControl = FUNCTION_CONTROLS.find((c) => c.key === 'filter');
  if (filterControl && filterControl.buttonEl) filterControl.buttonEl.hidden = active;

  pskSpotLabel.hidden = !active;

  scopeSpansEl.hidden = active;

  if (!active) {
    ft8TableBodyEl.innerHTML = '';
    ft8SlotTimeEl.textContent = '—';
    ft8StatusEl.hidden = true;
    // Leaving FT8 mode ends any in-progress guided QSO — a stale
    // partner/step from a previous session has no meaning once RX
    // decoding stops, and would otherwise silently resume "mid-QSO" the
    // next time FT8 mode is entered.
    ft8Qso.reset();
    hideQsoStatus();
    currentQsoFreqHz = null;
    scopeDisplay.setQsoFreq(null);
  }
}

/** Shows the guided-QSO progress line with the given text — see ft8-qso.js. */
function showQsoStatus(text) {
  ft8QsoStatusEl.textContent = text;
  ft8QsoStatusEl.hidden = false;
}

function hideQsoStatus() {
  ft8QsoStatusEl.hidden = true;
}

/**
 * Applies a guided-sequence suggestion (from Ft8QsoSequencer's engage()
 * or ingestDecodes()) to the UI: prefills the composer, shows the
 * progress line, and marks/tracks the QSO's frequency on the audio
 * spectrum and for the next send. Does nothing else — the operator still
 * reviews and presses Send themselves, same as any other composer text
 * (see ft8-qso.js's module doc comment on why this is guidance, not
 * automation).
 */
function applyFt8Suggestion(suggestion) {
  if (!suggestion) return;
  ft8ComposerInput.value = suggestion.txText;
  if (suggestion.statusText) showQsoStatus(suggestion.statusText);
  // Guided suggestions always carry their own tracked frequency in
  // practice (the decoded signal's own freq — see ft8-qso.js); the
  // fallback to the session's persisted default here is just defensive,
  // for the same reason every other "no more specific target" spot in
  // this file falls back to it rather than null (see
  // ft8DefaultTxFreqHz's doc comment).
  currentQsoFreqHz = suggestion.freqHz ?? ft8DefaultTxFreqHz;
  scopeDisplay.setQsoFreq(currentQsoFreqHz);
}

// --- FT8 band-activity table + composer ---

function formatUtcTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

link.addEventListener('ft8-decodes', (event) => {
  const { slotStartMs, messages } = event.detail || {};
  ft8SlotTimeEl.textContent = slotStartMs != null ? `slot ${formatUtcTime(slotStartMs)}Z` : '—';
  ft8TableBodyEl.innerHTML = '';
  if (!messages || messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ft8-table__empty';
    empty.textContent = 'No decodes this slot.';
    ft8TableBodyEl.appendChild(empty);
    return;
  }
  // Strongest signals first — the most useful ones to work are usually
  // near the top of a busy band-activity display, and it's also what
  // Ft8QsoSequencer#ingestDecodes() uses to deterministically pick the
  // clearest candidate when more than one message could advance/start a
  // guided QSO in the same slot (e.g. several callers answering our CQ
  // in a pileup) — see ft8-qso.js.
  const sorted = [...messages].sort((a, b) => b.snr - a.snr);

  // Auto-advance the guided sequence (if one is active/seeking) with
  // whatever this slot decoded, *before* rendering rows below, so the
  // active-QSO highlight below reflects this slot's state rather than
  // the previous one.
  applyFt8Suggestion(ft8Qso.ingestDecodes(sorted));
  const activeQso = ft8Qso.getQso();

  for (const msg of sorted) {
    const row = document.createElement('div');
    row.className = 'ft8-table__row';
    if (isRelatedToQso(msg, activeQso)) row.classList.add('ft8-table__row--qso');
    row.setAttribute('role', 'row');
    row.title = 'Click to copy this message into the composer';
    const utc = document.createElement('span');
    utc.textContent = slotStartMs != null ? formatUtcTime(slotStartMs) : '—';
    const dt = document.createElement('span');
    dt.textContent = typeof msg.dt === 'number' ? msg.dt.toFixed(1) : '—';
    const freq = document.createElement('span');
    freq.textContent = typeof msg.freq === 'number' ? `${Math.round(msg.freq)}Hz` : '—';
    const snr = document.createElement('span');
    snr.textContent = typeof msg.snr === 'number' ? `${msg.snr > 0 ? '+' : ''}${msg.snr}` : '—';
    const text = document.createElement('span');
    text.textContent = msg.msg || '';
    row.append(utc, dt, freq, snr, text);
    row.addEventListener('click', () => {
      // Guided engagement first — clicking a CQ (or, to pick a specific
      // caller out of a pileup, a reply to our own CQ) prefills the
      // appropriate next message in the standard FT8 exchange and tracks
      // the QSO (see ft8-qso.js). Anything engage() doesn't recognize
      // falls back to the original plain copy-into-composer behavior.
      const engaged = ft8Qso.engage(msg);
      if (engaged) {
        applyFt8Suggestion(engaged);
      } else {
        ft8ComposerInput.value = msg.msg || '';
      }
      ft8ComposerInput.focus();
    });
    ft8TableBodyEl.appendChild(row);
  }
});

link.addEventListener('ft8-tx-status', (event) => {
  const { status, message, error, sendAtMs } = event.detail || {};
  ft8StatusEl.hidden = false;
  ft8SendInFlight = status === 'scheduled' || status === 'sending';
  ft8SendBtn.disabled = ft8SendInFlight;
  switch (status) {
    case 'scheduled':
      ft8StatusEl.textContent = `Scheduled: "${message}" — sending at ${sendAtMs != null ? formatUtcTime(sendAtMs) : 'next slot'}Z`;
      break;
    case 'sending':
      ft8StatusEl.textContent = `Sending: "${message}"…`;
      break;
    case 'sent':
      ft8StatusEl.textContent = `Sent: "${message}"`;
      break;
    case 'error':
      ft8StatusEl.textContent = `FT8 TX failed: ${error || 'unknown error'}`;
      break;
    default:
      ft8StatusEl.hidden = true;
  }
});

function sendFt8Message() {
  const text = ft8ComposerInput.value.trim().toUpperCase();
  if (!text) return;

  // Sending our own default CQ arms the guided sequence to watch for a
  // reply (see ft8-qso.js's noteOwnCqSent() doc comment for why this
  // isn't inferred from every send — only this app's own recognized CQ
  // template counts). A CQ targets no *specific* (i.e. some other
  // station's) frequency of its own — it goes out at the session's
  // current default instead (see ft8DefaultTxFreqHz's doc comment), not
  // null, so the marker/next-send target don't just disappear.
  if (text === defaultCqMessage(stationCallsign, stationGrid)) {
    ft8Qso.noteOwnCqSent();
    currentQsoFreqHz = ft8DefaultTxFreqHz;
    scopeDisplay.setQsoFreq(currentQsoFreqHz);
    hideQsoStatus();
  }

  // currentQsoFreqHz targets this transmission at the frequency the
  // other station is actually listening on (see applyFt8Suggestion() and
  // docs/ui-notes.md), or at the session's persisted default absent a
  // more specific target — effectively always set once FT8 mode is
  // active (enterFt8Mode() seeds it), so this is sent explicitly rather
  // than relying on the server's own separate default.
  const request = currentQsoFreqHz != null ? { message: text, freqHz: currentQsoFreqHz } : { message: text };
  link.request('sendFt8', request).catch((err) => showError(`Couldn't send FT8 message: ${err.message}`));

  // Once the guided sequence has reached its final step, sending
  // whatever's in the composer wraps this QSO up — reset and get ready
  // for the next one rather than leaving a "completed" QSO sitting
  // highlighted and tracked indefinitely. Falls back to the session's
  // default frequency, not null, for the same reason as the fresh-CQ
  // case above.
  if (ft8Qso.getQso()?.step === 'complete') {
    ft8Qso.reset();
    currentQsoFreqHz = ft8DefaultTxFreqHz;
    scopeDisplay.setQsoFreq(currentQsoFreqHz);
    hideQsoStatus();
    ft8ComposerInput.value = defaultCqMessage(stationCallsign, stationGrid);
  }
}

ft8SendBtn.addEventListener('click', sendFt8Message);
ft8ComposerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendFt8Message();
});

/**
 * Toggles every CW-mode-dependent UI element together: swaps the single
 * PTT button for the dot/dash paddle pair, and shows/hides the CW decode
 * ticker under the S-meter (clearing its text on entry, matching the
 * server-side decoder's own reset when CW mode is freshly entered — see
 * cw-decoder-bridge.js — so a later CW session never starts with stale
 * leftover text from an earlier one). If a keying session happens to be
 * in progress at the moment the mode changes away from CW (e.g. the
 * radio itself pushed an unsolicited mode change), the session is
 * force-ended first — see docs/ui-notes.md for the paddle's latency
 * caveat and the defense-in-depth timeout that backs the server-side
 * watchdog.
 *
 * Also drives the scope's exact (unsnapped) click-to-tune for CW mode
 * (see ScopeDisplay#setCwMode()) — this is the single "is CW actually
 * active" determination every call site already needs to make, so
 * piggybacking on this function keeps both in sync automatically.
 */
function setCwPaddleVisible(visible) {
  if (!visible && (paddleDotDown || paddleDashDown)) {
    paddleDotDown = false;
    paddleDashDown = false;
    endKeyerSession();
  }
  pttBtn.hidden = visible;
  cwPaddleEl.hidden = !visible;
  pttHintEl.textContent = visible
    ? 'Hold Dot/Dash to key CW (iambic — hold both to alternate). CI-V round-trip latency may make timing less precise than a hardware keyer.'
    : 'Hold to transmit (or hold Space). First use will ask for microphone access.';

  cwTickerSectionEl.hidden = !visible;
  if (visible) {
    cwTickerTextEl.textContent = '';
  }
  scopeDisplay.setCwMode(visible);
}

/**
 * Shows/hides the RTTY decode ticker. Unlike CW, RTTY has no manual
 * keying UI to swap the PTT button out for (this is a decode-only
 * feature, matching what was actually requested — see
 * src/audio/rtty-decoder.js), so this is just the ticker-visibility half
 * of setCwPaddleVisible() above, with nothing to swap PTT for.
 *
 * Also drives the scope's RTTY mark/space offset marker (see
 * ScopeDisplay#setRttyMode()) and the "Reverse" checkbox's visibility —
 * every call site that decides RTTY-mode visibility already needs to make
 * exactly this same "RTTY, and not secretly FT8/FreeDV" determination, so
 * piggybacking on this one function keeps all three in sync automatically
 * rather than needing parallel visibility calls duplicated at every one of
 * those sites.
 */
function setRttyTickerVisible(visible) {
  rttyTickerSectionEl.hidden = !visible;
  if (visible) {
    rttyTickerTextEl.textContent = '';
  }
  scopeDisplay.setRttyMode(visible);
  rttyReverseLabel.hidden = !visible;
}

// --- Scope span ---
// Every SPAN_OPTIONS value maps exactly onto one of the radio's 8 fixed
// span presets — see docs/civ-notes.md — so no clamping/approximation is
// expected here in normal operation.
//
// A single horizontal <input type="range"> (see index.html) stands in
// for what used to be eight separate .chip buttons, per the original
// request. The slider's own value is an *index into SPAN_OPTIONS*, not a
// Hz value or anything else numeric about the span itself — the eight
// presets (2.5/5/10/25/50/100/250/500 kHz) are wildly uneven in Hz, and a
// slider scaled directly to Hz would bunch every useful low-end position
// into an unusable sliver at one end of the track. Indexing instead gives
// exactly the "eight settings at equal positions along its range" the
// request asked for, independent of what the underlying Hz values are.
const scopeSpanSlider = document.getElementById('scope-span-slider');
const scopeSpanValueEl = document.getElementById('scope-span-value');
scopeSpanSlider.max = String(SPAN_OPTIONS.length - 1);

// Live label update while dragging — same pattern as rxGainSlider's own
// 'input' handler below. The actual setScopeSpan request is deferred to
// 'change' (fires once, on release or an arrow-key commit) so dragging
// across several intermediate positions doesn't fire a request per
// position, only for the one the operator settles on.
scopeSpanSlider.addEventListener('input', () => {
  scopeSpanValueEl.textContent = SPAN_OPTIONS[Number(scopeSpanSlider.value)].label;
});
scopeSpanSlider.addEventListener('change', () => {
  requestScopeSpan(SPAN_OPTIONS[Number(scopeSpanSlider.value)]);
});

// Moves the slider (and label) to match the *actually observed* current
// span (from live scope-line data — see the onRangeUpdate wiring above),
// not wherever it was last dragged to. Same principle as
// updateModeButtons()/updateBandButtons(): reflect confirmed state, not
// drag intent — the display should never claim something is active that
// the radio hasn't actually confirmed by reporting it.
//
// `hi - lo` is the *total* displayed width, but SPAN_OPTIONS.spanHz (and
// the label shown, e.g. "100 kHz") is the width to each side of center —
// see scope.js's pushLine() doc comment for why, confirmed on real
// hardware — so this halves the observed width back to a one-sided value
// before matching it against SPAN_OPTIONS. A reported width that doesn't
// exactly match any SPAN_OPTIONS entry (shouldn't happen in normal
// operation — see docs/civ-notes.md) leaves the slider at its current
// position rather than guessing.
function updateSpanSliderFromRange(lo, hi) {
  if (lo == null || hi == null) return;
  const halfWidthHz = Math.round((hi - lo) / 2);
  const index = SPAN_OPTIONS.findIndex((o) => o.spanHz === halfWidthHz);
  if (index === -1) return;
  scopeSpanSlider.value = String(index);
  scopeSpanValueEl.textContent = SPAN_OPTIONS[index].label;
}

function requestScopeSpan(option) {
  link
    .request('setScopeSpan', { spanHz: option.spanHz })
    .catch((err) => showError(`Couldn't set scope span: ${err.message}`));
  // No optimistic slider/label update beyond what the 'input' handler
  // already applied — updateSpanSliderFromRange() will reflect the
  // radio's actual confirmed span once the next scope-line arrives.
}

// --- Function controls (Preamp / NR / Notch / Filter) ---
// These settings aren't part of the radio's unsolicited "transceive"
// broadcasts the way frequency/mode are, so there's no free push-based
// way to stay in sync with them — including changes made from the
// radio's own front panel, not just this UI. Rather than optimistically
// assume a click's requested state took effect (the same trap the scope
// span buttons avoid — see docs/ui-notes.md), each button's displayed
// text always comes from an explicit re-sync after clicking, not from
// assuming the click succeeded — see syncFunctionControl() below.
for (const control of FUNCTION_CONTROLS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip function-control__button';
  button.disabled = true; // enabled once we're connected
  button.textContent = `${control.label} ${control.options[0].shortLabel}`;
  button.addEventListener('click', () => {
    const fromIndex = control.currentIndex ?? 0;
    const nextIndex = (fromIndex + 1) % control.options.length;
    const nextOption = control.options[nextIndex];
    link
      .request(control.request, { [control.paramName]: nextOption.value })
      .then(() => syncFunctionControl(control)) // re-read the confirmed value immediately, don't assume it
      .catch((err) => showError(`Couldn't set ${control.label}: ${err.message}`));
  });
  functionControlsEl.appendChild(button);
  control.buttonEl = button;
}

// --- "PSK Spot" checkbox (FT8-mode only) ---
// Reports decoded FT8 stations to pskreporter.info while checked — see
// src/audio/psk-reporter.js for the actual UDP client/protocol this
// drives server-side. Placed directly after the Notch button (Notch is
// the only FUNCTION_CONTROLS entry that stays visible during FT8 mode —
// see setFt8UiVisible() below) so it lands "below the Notch button" in
// this column's layout regardless of the (hidden, while FT8 is active)
// Filter button after it. Checked by default per the original request;
// hidden outside FT8 mode the same way the FT8 panel itself is.
const pskSpotCheckbox = document.createElement('input');
pskSpotCheckbox.type = 'checkbox';
pskSpotCheckbox.id = 'psk-spot-checkbox';
pskSpotCheckbox.checked = true;
pskSpotCheckbox.addEventListener('change', () => {
  link
    .request('setPskSpotEnabled', { enabled: pskSpotCheckbox.checked })
    .catch((err) => showError(`Couldn't update PSK Spot: ${err.message}`));
});

const pskSpotLabel = document.createElement('label');
pskSpotLabel.className = 'chip function-control__button psk-spot-toggle';
pskSpotLabel.hidden = true; // shown only while FT8 mode is active — see setFt8UiVisible()
pskSpotLabel.appendChild(pskSpotCheckbox);
pskSpotLabel.appendChild(document.createTextNode('PSK Spot'));

const notchControl = FUNCTION_CONTROLS.find((c) => c.key === 'notch');
if (notchControl && notchControl.buttonEl) {
  notchControl.buttonEl.insertAdjacentElement('afterend', pskSpotLabel);
} else {
  functionControlsEl.appendChild(pskSpotLabel);
}

// --- "RNN" N-state cycling button (replaces the old Noise Blanker/"NB" button, in its exact former slot) ---
// Arms/disarms an RNNoise speech-denoiser on the RX audio path — see
// server/audio-bridge.js#setRnnoiseLevel for the full server-side
// mechanics, and its own doc comment for why this deliberately does NOT
// affect CW/RTTY/FT8/RADE decoding (RNNoise only ever touches the audio
// actually broadcast to clients — i.e. what the operator hears — never
// the raw capture stream those decoders tap independently). Unlike FDV
// Spot below, this is relevant in any RX mode (noise reduction isn't
// FreeDV-specific), so it's always visible — same as NB used to be — not
// mode-gated.
//
// Unlike the FUNCTION_CONTROLS entries (P.Amp/NR/Notch/Filter), RNN's
// state isn't CI-V-backed, so there's nothing for a getRequest/CI-V poll
// to re-sync from — the server is the sole source of truth and pushes
// changes itself (REQUEST.SET_RNNOISE_LEVEL's result, plus
// EVENT.RNNOISE_LEVEL broadcasts to every OTHER connected client) rather
// than this button re-reading anything from the radio. That's why this
// is a bespoke click-to-cycle button rather than another
// FUNCTION_CONTROLS entry, even though it's styled identically.
//
// Level 0 ("RNN Off") is the default: like every other opt-in toggle
// here, enabling a real child-process audio filter should be something
// the operator explicitly starts. Levels 1..N step through fixed
// original/denoised blend ratios configured server-side via the
// RNNOISE_WET env var (a comma-separated list of wet ratios — see
// RNNOISE_WET_LEVELS in src/server/index.js and RNNOISE_LEVEL_WET in
// audio-bridge.js), so the NUMBER of levels is itself configurable, not
// fixed at 5 — hence this being built from `data.rnnoiseLevelCount` in
// the 'connected' snapshot handler below rather than hardcoded here.
// `buildRnnLevels()` is called once with a sane 5-level default so the
// button has *something* to show before the first server snapshot
// arrives (it stays disabled until then regardless — see
// setRnnoiseButtonLevel() below), then rebuilt to match whatever count
// the server actually reports.
function buildRnnLevels(count) {
  const levels = [{ label: 'RNN Off', level: 0 }];
  for (let i = 1; i < count; i++) levels.push({ label: `RNN ${i}`, level: i });
  return levels;
}
let RNN_LEVELS = buildRnnLevels(5);
let rnnoiseLevel = 0;

const rnnoiseButton = document.createElement('button');
rnnoiseButton.type = 'button';
rnnoiseButton.id = 'rnnoise-button';
rnnoiseButton.className = 'chip function-control__button rnnoise-toggle';
rnnoiseButton.disabled = true;
rnnoiseButton.textContent = RNN_LEVELS[0].label;

function setRnnoiseButtonLevel(level) {
  // Defends against a stale/out-of-range level arriving before
  // RNN_LEVELS has been resized to match the server's actual count (or
  // after a server restart with a shorter RNNOISE_WET list than before) —
  // clamp rather than throw on a bad array index.
  const clamped = Math.max(0, Math.min(level, RNN_LEVELS.length - 1));
  rnnoiseLevel = clamped;
  rnnoiseButton.textContent = RNN_LEVELS[clamped].label;
  rnnoiseButton.disabled = false;
}

rnnoiseButton.addEventListener('click', () => {
  const nextLevel = (rnnoiseLevel + 1) % RNN_LEVELS.length;
  link
    .request('setRnnoiseLevel', { level: nextLevel })
    .then(() => setRnnoiseButtonLevel(nextLevel))
    .catch((err) => showError(`Couldn't update RNN noise reduction: ${err.message}`));
});

// Inserted right after the NR button — NB's exact old slot in this
// column (P.Amp / NR / RNN / Notch / Filter), now that the NB
// FUNCTION_CONTROLS entry itself is removed (server-side CI-V Noise
// Blanker support — setNoiseBlanker/getNoiseBlanker — is untouched, only
// this UI control is gone, per the original request).
const nrControl = FUNCTION_CONTROLS.find((c) => c.key === 'nr');
if (nrControl && nrControl.buttonEl) {
  nrControl.buttonEl.insertAdjacentElement('afterend', rnnoiseButton);
} else {
  functionControlsEl.appendChild(rnnoiseButton);
}

// HamNoise toggle — a BSRNN-based denoiser (see server/audio-bridge.js's
// class doc comment and models/hamnoise/NOTICE.md), mutually exclusive
// with the RNN button above: selecting one always forces the other off,
// whether that happens here (the click handler below) or server-side
// (AudioBridge forcing this one off when RNN is armed, which arrives as
// a 'hamnoise-enabled' event — see the listener near the other link
// event listeners). It stays compatible with the radio's own hardware
// NR (the "NR" function control), which is a separate signal path.
let hamNoiseEnabled = false;
const hamnoiseButton = document.createElement('button');
hamnoiseButton.type = 'button';
hamnoiseButton.id = 'hamnoise-button';
hamnoiseButton.className = 'chip function-control__button hamnoise-toggle';
hamnoiseButton.disabled = true;
hamnoiseButton.textContent = 'HamNoise Off';

function setHamNoiseButtonState(enabled) {
  hamNoiseEnabled = enabled;
  hamnoiseButton.textContent = enabled ? 'HamNoise On' : 'HamNoise Off';
  hamnoiseButton.disabled = false;
}

hamnoiseButton.addEventListener('click', () => {
  const nextEnabled = !hamNoiseEnabled;
  link
    .request('setHamnoiseEnabled', { enabled: nextEnabled })
    .then(() => setHamNoiseButtonState(nextEnabled))
    .catch((err) => showError(`Couldn't update HamNoise noise reduction: ${err.message}`));
});

// Beneath the RNN button, per the request this implements.
rnnoiseButton.insertAdjacentElement('afterend', hamnoiseButton);

/**
 * Fetches one function control's actual current value from the radio and
 * updates its button's text to match. Called both on the periodic poll
 * and immediately after a click, so the button reflects confirmed
 * reality either way rather than the state that was merely requested.
 */
async function syncFunctionControl(control) {
  try {
    const data = await link.request(control.getRequest);
    const value = data[control.paramName];
    const index = control.options.findIndex((option) => option.value === value);
    if (index !== -1) {
      control.currentIndex = index;
      control.buttonEl.textContent = `${control.label} ${control.options[index].shortLabel}`;
    }
  } catch {
    // transient — next poll will retry, matching meter polling's pattern
  }
}

/** Same idea as syncFunctionControl(), for the tuner on/off button. */
async function syncTuner() {
  try {
    const data = await link.request('getTuner');
    tunerOn = data.value === 1;
    tunerBtn.textContent = tunerOn ? 'Tuner: on' : 'Tuner: off';
    tunerBtn.classList.toggle('chip--active', tunerOn);
  } catch {
    // transient — next poll will retry
  }
}

// --- S-meter ---
// Icom S-meter readings are roughly 0-255; there's no unsolicited
// transceive push for it on most rigs, so it's polled. Bucketed per real
// calibration data in smeter.js (S0, S1-S3, S4-S9, +10dB through +60dB
// over S9) — see that file for the source and a note on why S1-S3 is a
// single combined bucket rather than three individual ones.
const meterSegmentEls = S_METER_LEVELS.map((level) => {
  const seg = document.createElement('div');
  seg.className = 'meter__segment';
  if (level.over) seg.classList.add('meter__segment--over');
  const label = document.createElement('span');
  label.className = 'meter__segment-label';
  label.textContent = level.barLabel;
  seg.appendChild(label);
  meterBarEl.appendChild(seg);
  return seg;
});

function updateMeter(value) {
  const idx = sMeterLevelIndex(value);
  // Per explicit request, just the bucketed label — no raw meter reading
  // alongside it (same change already made to the VSWR-mode text below;
  // `value` is still used for the actual bucket lookup above).
  meterValue.textContent = sMeterLabel(value);
  meterSegmentEls.forEach((seg, i) => {
    seg.classList.toggle('meter__segment--active', i <= idx);
    // Clear any leftover VSWR-mode coloring from a previous PTT session —
    // the two display modes use independent classes (see updateMeterAsVswr)
    // so switching back to S-meter mode needs to explicitly reset these.
    seg.classList.remove('meter__segment--vswr-green', 'meter__segment--vswr-orange', 'meter__segment--vswr-red');
  });
}

/**
 * Repurposes the same 16-segment bar used for the S-meter to show VSWR
 * while transmitting — see docs/ui-notes.md for why PTT triggers this
 * switch and why VSWR uses its own independent set of classes rather
 * than reusing --active/--over (some segments carry --over permanently,
 * based on their S-unit bucket identity, which would conflict with
 * toggling it per-zone here).
 */
function updateMeterAsVswr(raw) {
  const vswr = rawToVswr(raw);
  const zone = vswrZone(vswr);
  const activeCount = Math.round(((vswr - 1) / 4) * meterSegmentEls.length);
  // Per explicit request, just the computed VSWR ratio — no raw meter
  // reading alongside it (the raw value is still passed in and used for
  // the actual computation above; only the displayed text changed).
  meterValue.textContent = `VSWR ${vswr.toFixed(1)}`;
  meterSegmentEls.forEach((seg, i) => {
    const active = i < activeCount;
    seg.classList.remove('meter__segment--active'); // S-meter-mode class, not used here
    seg.classList.toggle('meter__segment--vswr-green', active && zone === 'green');
    seg.classList.toggle('meter__segment--vswr-orange', active && zone === 'orange');
    seg.classList.toggle('meter__segment--vswr-red', active && zone === 'red');
  });
}

function startMeterPolling() {
  stopMeterPolling();
  let inFlight = false;
  meterPollTimer = setInterval(async () => {
    if (inFlight || !link.connected) return;
    inFlight = true;
    try {
      if (pttActive) {
        const data = await link.request('getSWR');
        updateMeterAsVswr(data.value);
      } else {
        const data = await link.request('getSMeter');
        updateMeter(data.value);
      }
    } catch {
      // transient — next poll will retry
    } finally {
      inFlight = false;
    }
  }, 500);
}

function stopMeterPolling() {
  if (meterPollTimer) clearInterval(meterPollTimer);
  meterPollTimer = null;
}

/**
 * Keeps Preamp/NR/Notch/Filter/Tuner in sync with the radio's actual state —
 * including changes made from the front panel, not just this UI — since
 * none of them are part of the CI-V "transceive" unsolicited-push
 * mechanism frequency/mode use. Polled less aggressively than the
 * S-meter (2s vs 500ms): these change far less often, and each poll tick
 * here is 5 sequential CI-V round-trips (deliberately sequential, not
 * parallel, to avoid hammering the half-duplex serial bus — same
 * principle as the scope's careful bus-traffic management), so a tighter
 * interval would add meaningful CI-V bus load for little practical
 * benefit — a toggle a human just flipped on the front panel doesn't
 * need sub-second confirmation the way a live meter does.
 */
function startFunctionPolling() {
  stopFunctionPolling();
  let inFlight = false;
  const poll = async () => {
    if (inFlight || !link.connected) return;
    inFlight = true;
    try {
      for (const control of FUNCTION_CONTROLS) {
        await syncFunctionControl(control);
      }
      await syncTuner();
      await syncTxPower();
      await syncRxGain();
    } finally {
      inFlight = false;
    }
  };
  poll(); // sync immediately on connect, don't wait for the first interval tick
  functionPollTimer = setInterval(poll, 2000);
}

function stopFunctionPolling() {
  if (functionPollTimer) clearInterval(functionPollTimer);
  functionPollTimer = null;
}

// --- Speaker ---
let speakerOn = false;
speakerBtn.addEventListener('click', async () => {
  if (!audioPipeline) return;
  if (!speakerOn) {
    try {
      await audioPipeline.enableSpeaker();
      speakerOn = true;
      speakerBtn.textContent = 'Speaker: on';
      speakerBtn.classList.add('chip--active');
    } catch (err) {
      showError(`Couldn't enable speaker: ${err.message}`);
    }
  } else {
    audioPipeline.disableSpeaker();
    speakerOn = false;
    speakerBtn.textContent = 'Speaker: off';
    speakerBtn.classList.remove('chip--active');
  }
});

// --- Tuner ---
// Toggle button (on/off) plus a separate one-shot "Tune" action button —
// both go through CivDriver#setTuner(), which treats 0/1 as persistent
// states and 2 as a one-shot "start tuning now" trigger (see its doc
// comment). Like the function-control dropdowns above, the on/off
// button's displayed state comes from polling the radio's actual value
// (syncTuner(), via startFunctionPolling() below), not from assuming the
// click succeeded — the same "never claim something the radio hasn't
// actually confirmed" principle used throughout this UI. No optimistic
// "tuning..." state for the Tune button either: the radio doesn't report
// tuning progress/completion over CI-V in a way this project decodes, so
// it just fires the request and relies on the error toast if it fails.
let tunerOn = false;
tunerBtn.addEventListener('click', () => {
  link
    .request('setTuner', { value: tunerOn ? 0 : 1 })
    .catch((err) => showError(`Couldn't set tuner: ${err.message}`));
});

tuneBtn.addEventListener('click', () => {
  link.request('setTuner', { value: 2 }).catch((err) => showError(`Couldn't start tuning: ${err.message}`));
});

// --- "FreeDV spot" checkbox (placed directly below the Filter button) ---
// Reports this station to the FreeDV Reporter live activity map
// (qso.freedv.org) while checked AND FreeDV mode is armed — see
// src/server/freedv-reporter.js for the actual Socket.IO client this
// drives server-side. Like "PSK Spot" (placed after Notch, in the same
// function-controls column), this is only shown while FreeDV mode is
// active — see enterFreeDvMode()/exitFreeDvMode() — and defaults OFF per
// the original request, since reporting your callsign/grid/frequency to a
// third-party service should be something the operator explicitly opts
// into. Moved here (below Filter, the last FUNCTION_CONTROLS entry) per
// explicit request; it used to sit inline in .controls-row next to the
// Tune button.
const freeDvSpotCheckbox = document.createElement('input');
freeDvSpotCheckbox.type = 'checkbox';
freeDvSpotCheckbox.id = 'freedv-spot-checkbox';
freeDvSpotCheckbox.checked = false;
freeDvSpotCheckbox.addEventListener('change', () => {
  link
    .request('setFreeDvSpotEnabled', { enabled: freeDvSpotCheckbox.checked })
    .catch((err) => showError(`Couldn't update FreeDV spot: ${err.message}`));
});

const freeDvSpotLabel = document.createElement('label');
freeDvSpotLabel.className = 'chip function-control__button freedv-spot-toggle';
freeDvSpotLabel.hidden = true; // shown only while FreeDV mode is active — see enterFreeDvMode()/exitFreeDvMode()
freeDvSpotLabel.appendChild(freeDvSpotCheckbox);
freeDvSpotLabel.appendChild(document.createTextNode('FDV Spot')); // shortened per explicit request; was "FreeDV spot"

const freeDvFilterControl = FUNCTION_CONTROLS.find((c) => c.key === 'filter');
if (freeDvFilterControl && freeDvFilterControl.buttonEl) {
  freeDvFilterControl.buttonEl.insertAdjacentElement('afterend', freeDvSpotLabel);
} else {
  functionControlsEl.appendChild(freeDvSpotLabel);
}

// --- RTTY "Reverse" checkbox (lives inside the RTTY ticker section) ---
// Swaps which tone (mark/space) the decoder treats as which — see
// src/audio/rtty-decoder.js's own constructor doc comment for why this
// exists: RTTY polarity genuinely isn't predictable from the radio's mode
// alone (it depends on both stations' equipment), so every real RTTY
// terminal program (fldigi, MMTTY) offers exactly this same manual toggle
// rather than guessing. Unchecked by default — a signal already decoding
// fine shouldn't need touching. Visibility is driven from
// setRttyTickerVisible() below, the single "is RTTY actually active"
// determination already shared with the ticker itself and the waterfall's
// RTTY markers, so this stays in sync with both automatically.
const rttyReverseCheckbox = document.createElement('input');
rttyReverseCheckbox.type = 'checkbox';
rttyReverseCheckbox.id = 'rtty-reverse-checkbox';
rttyReverseCheckbox.checked = false;
rttyReverseCheckbox.addEventListener('change', () => {
  link
    .request('setRttyReversed', { reversed: rttyReverseCheckbox.checked })
    .catch((err) => showError(`Couldn't update RTTY reverse: ${err.message}`));
});

const rttyReverseLabel = document.createElement('label');
rttyReverseLabel.className = 'chip cw-ticker__reverse-toggle';
rttyReverseLabel.hidden = true; // shown only while the RTTY ticker itself is — see setRttyTickerVisible()
rttyReverseLabel.appendChild(rttyReverseCheckbox);
rttyReverseLabel.appendChild(document.createTextNode('Reverse'));
rttyTickerSectionEl.appendChild(rttyReverseLabel);

// --- FreeDV Reporter: status message ---
// Standing state (SET_FREEDV_MESSAGE / message_update) — sent on every
// change, restored from the 'connected' snapshot, and kept in sync with
// other connected clients via the 'freedv-message' broadcast below.
function showFreeDvReportStatus(text) {
  freeDvReportStatusEl.textContent = text;
  freeDvReportStatusEl.hidden = false;
}

function sendFreeDvMessage() {
  const message = freeDvMessageInput.value;
  link
    .request('setFreeDvMessage', { message })
    .then(() => showFreeDvReportStatus(message ? 'Status message updated' : 'Status message cleared'))
    .catch((err) => showError(`Couldn't update FreeDV message: ${err.message}`));
}

freeDvMessageSetBtn.addEventListener('click', sendFreeDvMessage);
freeDvMessageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendFreeDvMessage();
});

// Another connected client (or this one's own confirmed change) updates
// the message field — see EVENT.FREEDV_MESSAGE / ws-server.js. Skipped
// while this input has focus so it doesn't clobber an in-progress edit.
link.addEventListener('freedv-message', (event) => {
  const { message } = event.detail || {};
  if (document.activeElement !== freeDvMessageInput) freeDvMessageInput.value = message || '';
});

// --- TX power ---
// Same "never assume, only show confirmed" principle as the function
// control buttons: a change fires the request, then immediately re-syncs
// from an explicit read rather than assuming the new value took effect.
// Unlike those (now plain buttons), this stays a real <select> per the
// request, so — like the dropdowns this whole app used to use for
// Preamp/NR/NB/Notch before they became buttons — syncing is skipped
// while it's focused, so a poll landing while the native picker is open
// can't yank the selection out from under an in-progress choice.
TX_POWER_OPTIONS.forEach((option, index) => {
  const opt = document.createElement('option');
  opt.value = String(index);
  opt.textContent = option.label;
  txPowerSelect.appendChild(opt);
});
txPowerSelect.addEventListener('change', () => {
  const option = TX_POWER_OPTIONS[txPowerSelect.selectedIndex];
  link
    .request('setTxPower', { watts: option.watts })
    .then(() => syncTxPower())
    .catch((err) => showError(`Couldn't set TX power: ${err.message}`));
});

async function syncTxPower() {
  if (document.activeElement === txPowerSelect) return;
  try {
    const data = await link.request('getTxPower');
    const index = TX_POWER_OPTIONS.findIndex((option) => option.watts === data.watts);
    if (index !== -1) txPowerSelect.selectedIndex = index;
  } catch {
    // transient — next poll will retry
  }
}

// --- RX gain ---
// Same "confirm then re-sync" pattern as the other controls, but the
// actual CI-V write only fires on 'change' (drag released / value
// committed), not on every 'input' tick — a slider firing a request per
// pixel of drag would flood the serial bus. The adjacent label is a
// static "RX Gain" (see index.html) rather than a live numeric readout —
// per explicit request — so there's nothing to update on 'input' here
// beyond the slider's own thumb position, which the browser already
// handles natively.
let isDraggingRxGain = false;
rxGainSlider.addEventListener('pointerdown', () => {
  isDraggingRxGain = true;
});
rxGainSlider.addEventListener('pointerup', () => {
  isDraggingRxGain = false;
});
rxGainSlider.addEventListener('change', () => {
  const value = Number(rxGainSlider.value);
  link
    .request('setRxGain', { value })
    .then(() => syncRxGain())
    .catch((err) => showError(`Couldn't set RX gain: ${err.message}`));
});

async function syncRxGain() {
  if (isDraggingRxGain) return;
  try {
    const data = await link.request('getRxGain');
    rxGainSlider.value = String(data.value);
  } catch {
    // transient — next poll will retry
  }
}

// --- PTT ---
function updatePttVisual(on) {
  pttBtn.classList.toggle('ptt--active', !!on);
  pttBtn.textContent = on ? 'TRANSMITTING' : 'PUSH TO TALK';
}

async function engagePtt() {
  if (pttActive) return;
  pttActive = true;
  updatePttVisual(true);
  if (audioPipeline) {
    try {
      await audioPipeline.startTransmitting();
    } catch (err) {
      showError(`Couldn't access microphone: ${err.message}`);
    }
  }
  link.request('setPtt', { value: true }).catch((err) => {
    showError(err.message);
    releasePtt();
  });
}

function releasePtt() {
  if (!pttActive) return;
  pttActive = false;
  updatePttVisual(false);
  if (audioPipeline) audioPipeline.stopTransmitting();
  link.request('setPtt', { value: false }).catch((err) => showError(err.message));
}

pttBtn.addEventListener('pointerdown', (event) => {
  pttBtn.setPointerCapture(event.pointerId);
  engagePtt();
});
pttBtn.addEventListener('pointerup', releasePtt);
pttBtn.addEventListener('pointercancel', releasePtt);
pttBtn.addEventListener('lostpointercapture', releasePtt);

// Spacebar as a convenience PTT, but not while the frequency input (or
// any other text field, e.g. the FT8 composer or the CW WPM field) has
// focus — checked generically by tag/type rather than by naming each
// input individually, since the previous version of this check only
// actually excluded freqInput despite its own comment claiming "any
// other text field" too, which the FT8 composer's spaces (e.g. typing
// "CQ VK2IO QF56") would otherwise have hit.
function isTextEntryFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(type);
  }
  return false;
}
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !isTextEntryFocused() && !event.repeat) {
    event.preventDefault();
    engagePtt();
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') releasePtt();
});

// --- CW iambic paddle ---
// Shares pttActive/updatePttVisual with the main PTT flow (for one
// concrete reason: the S-meter/VSWR display switch checks pttActive —
// see startMeterPolling() — so CW keying needs to be visible to it the
// same way voice PTT is), but does NOT go through engagePtt()/
// releasePtt() themselves, since those also start/stop the microphone
// audio pipeline, which CW keying has no use for.
//
// Latency caveat, worth being upfront about: there is no CI-V primitive
// for "key down for N milliseconds" — the only way to produce a dot or
// dash is toggling the same setPtt command used for voice PTT, once per
// element, over the WebSocket + serial round trip. At typical WPM this
// timing will be visibly less precise than a hardware keyer or the
// radio's own internal one; the default 15 WPM here is a deliberately
// conservative starting point given that latency, not a claim of
// contest-grade keying. See docs/ui-notes.md.
let paddleDotDown = false;
let paddleDashDown = false;
let keyerLoopRunning = false;
let lastKeyerElementWasDash = false; // alternates dot/dash when both paddles are squeezed
let keyerSessionStartedAt = null;

function keyerUnitMs() {
  const wpm = Math.max(5, Math.min(40, Number(cwWpmInput.value) || 15));
  return 1200 / wpm; // standard PARIS-word timing convention
}

function startKeyerSession() {
  if (pttActive) return;
  pttActive = true;
  keyerSessionStartedAt = Date.now();
  updatePttVisual(true);
}

function endKeyerSession() {
  if (!pttActive) return;
  pttActive = false;
  keyerSessionStartedAt = null;
  updatePttVisual(false);
  link.request('setPtt', { value: false }).catch((err) => showError(err.message));
}

async function runKeyerLoop() {
  if (keyerLoopRunning) return;
  keyerLoopRunning = true;
  startKeyerSession();
  try {
    while (paddleDotDown || paddleDashDown) {
      // Defense-in-depth against the 10-minute fail-safe: the server
      // watchdog resets on every element's off-period (correctly, so
      // normal keying never trips it — see docs/civ-notes.md), which
      // means a genuinely stuck paddle producing continuous keying for
      // the entire 10 minutes wouldn't hit that backstop the same way a
      // held voice PTT would. This client-side session-length check
      // closes that specific gap.
      if (keyerSessionStartedAt != null && Date.now() - keyerSessionStartedAt > 10 * 60 * 1000) {
        showError('CW keying automatically stopped after 10 minutes (fail-safe cutoff).');
        break;
      }
      const sendDash = paddleDotDown && paddleDashDown ? !lastKeyerElementWasDash : paddleDashDown;
      lastKeyerElementWasDash = sendDash;
      cwDotBtn.classList.toggle('cw-paddle__btn--active', !sendDash);
      cwDashBtn.classList.toggle('cw-paddle__btn--active', sendDash);
      const elementMs = sendDash ? keyerUnitMs() * 3 : keyerUnitMs();
      await link.request('setPtt', { value: true }).catch((err) => showError(err.message));
      await new Promise((resolve) => setTimeout(resolve, elementMs));
      await link.request('setPtt', { value: false }).catch((err) => showError(err.message));
      cwDotBtn.classList.remove('cw-paddle__btn--active');
      cwDashBtn.classList.remove('cw-paddle__btn--active');
      if (!paddleDotDown && !paddleDashDown) break;
      await new Promise((resolve) => setTimeout(resolve, keyerUnitMs())); // inter-element gap
    }
  } finally {
    keyerLoopRunning = false;
    paddleDotDown = false;
    paddleDashDown = false;
    endKeyerSession();
  }
}

cwDotBtn.addEventListener('pointerdown', (event) => {
  cwDotBtn.setPointerCapture(event.pointerId);
  paddleDotDown = true;
  runKeyerLoop();
});
cwDotBtn.addEventListener('pointerup', () => {
  paddleDotDown = false;
});
cwDotBtn.addEventListener('pointercancel', () => {
  paddleDotDown = false;
});
cwDotBtn.addEventListener('lostpointercapture', () => {
  paddleDotDown = false;
});

cwDashBtn.addEventListener('pointerdown', (event) => {
  cwDashBtn.setPointerCapture(event.pointerId);
  paddleDashDown = true;
  runKeyerLoop();
});
cwDashBtn.addEventListener('pointerup', () => {
  paddleDashDown = false;
});
cwDashBtn.addEventListener('pointercancel', () => {
  paddleDashDown = false;
});
cwDashBtn.addEventListener('lostpointercapture', () => {
  paddleDashDown = false;
});
