import { RigLink } from './rpc.js';
import { CallAlert, baseCall } from './call-alert.js';
import { AudioPipeline, opusSupport, isLanHost } from './audio.js';
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
  { name: '80m', hz: 3600000 },
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
//
// The 'TTY' chip stands in for what used to be the separate RTTY chip: a
// first click selects RTTY (an ordinary CI-V hardware mode, see MODES) and
// relabels the chip "RTTY"; every later click toggles RTTY <-> JTTY (an
// app-level pseudo-mode like FT8, running on USB + DATA MODE) and relabels
// it to match, until some non-TTY mode is picked and it reverts to "TTY".
// See ttyMode()/updateTtyUi() and the 'TTY' branch in the render loop.
//
// Since then the rows were rearranged (two rows of four): SSB, AM, FM, CW on
// top; TTY, DIGI, FreeDV, SSTV below. 'SSB' is one toggle for LSB and USB:
// the first click picks the usual sideband for the band (LSB below 10 MHz,
// USB above), a click while in LSB/USB switches to the other, and the chip
// reads "LSB"/"USB" while selected. 'DIGI' is the FT8/FT4 chip (it reads
// "FT8" or "FT4" while selected). 'SSTV' is the SSTV receiver (app-level,
// on the band's sideband like voice); see enterSstvMode().
const MODE_CHIPS = ['SSB', 'AM', 'FM', 'CW', 'TTY', 'DIGI', 'FreeDV', 'Image'];

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

// JTTY dial frequencies (USB), from the WSJT-X 3.3 beta list as published at
// https://www.dxzone.com/jtty-frequencies/. The developers call them very
// preliminary and expect some to change, so keep this table easy to edit.
// The signal itself sits ~1.5 kHz above the dial frequency (see
// JTTY_TX_FREQ_HZ); the 2m entry (144.160) has no band chip here.
const JTTY_FREQUENCIES = {
  '160m': 1838000,
  '80m': 3575000,
  '40m': 7090000,
  '30m': 10140000,
  '20m': 14090000,
  '17m': 18100000,
  '15m': 21090000,
  '12m': 24920000,
  '10m': 28090000,
  '6m': 50160000,
};

// Olivia 8/250 dial frequencies (USB), from the "suggested calling
// frequencies" table in Wikipedia's Olivia MFSK article
// (https://en.wikipedia.org/wiki/Olivia_MFSK): each centre frequency less
// 1.5 kHz, so the signal sits on the default 1500 Hz audio centre. 160m uses
// the Region 1/3 entry (1.8375 MHz dial); 6m has no entry, so its chip
// keeps its ordinary quick-tune point. Calling frequencies only — move off
// after making contact.
const OLIVIA_FREQUENCIES = {
  '160m': 1837500,
  '80m': 3581500,
  '40m': 7071500,
  '30m': 10141500,
  '20m': 14071500,
  '17m': 18097500,
  '15m': 21071500,
  '12m': 24921500,
  '10m': 28121500,
};
const OLIVIA_DEFAULT_CENTRE_HZ = 1500;
const OLIVIA_MIN_CENTRE_HZ = 400; // same limits as the server (audio/olivia-dsp.js)
const OLIVIA_MAX_CENTRE_HZ = 2600;
const OLIVIA_HALF_SPAN_HZ = 109.375; // centre to outer tone, 8/250

// RTTY: the centre of each band's digital-modes segment in the WIA
// (Australian) band plan, as listed in the WIA Technical Advisory
// Committee's "HF Digimodes" band-plan paper
// (https://www.wia.org.au/members/bandplans/data/documents/TAC%20Band%20Plans%20-%20HF%20Digimodes%20170103.pdf).
// RTTY has no calling frequencies; this just starts you in the middle of
// where it is allowed, to tune around from. The radio's RTTY mode shows the
// mark frequency, so these are mark frequencies. Segments (MHz):
//   160m 1.800-1.810   80m 3.620-3.640   40m 7.040-7.060   30m 10.130-10.140
//   20m 14.070-14.112  17m 18.100-18.110 15m 21.070-21.125 12m 24.920-24.930
//   10m 28.050-28.150
// The paper also proposes changes (e.g. 80m to 3.570-3.600, where most RTTY
// is heard worldwide); update this table if the WIA adopts them. 6m has no
// HF digimode segment, so its chip keeps its ordinary quick-tune point.
const RTTY_FREQUENCIES = {
  '160m': 1805000,
  '80m': 3630000,
  '40m': 7050000,
  '30m': 10135000,
  '20m': 14091000,
  '17m': 18105000,
  '15m': 21097500,
  '12m': 24925000,
  '10m': 28100000,
};

// Feld-Hell activity frequencies (signal frequency, USB), the bottom of each
// range in the Feld Hell Club's list
// (https://www.sites.google.com/site/feldhellclub/Home/frequencies), 20m
// being its "preferred" 14.063. 30m is the exception: the club gives
// 10.137-10.144, whose bottom overlaps FT8 (10.136-10.139), so 10.142 is
// used. The dial is set below these by the current audio tone (1000 Hz by
// default) so the signal lands on them.
// SSTV calling frequencies (dial, on the band's usual sideband: LSB below
// 10 MHz, USB above), from the usual worldwide list (e.g.
// https://www.sigidwiki.com/wiki/SSTV). Only bands whose usual frequency is
// inside the Australian allocation are listed: 80m's 3.730 / 3.845 MHz and
// 160m's 1.890 MHz are not, so on those bands the band button tunes as
// usual. 6m uses the 50.950 MHz USB frequency (50.680 is FM).
const SSTV_FREQUENCIES = {
  '40m': 7171000,
  '20m': 14230000,
  '15m': 21340000,
  '10m': 28680000,
  '6m': 50950000,
};

const HELL_FREQUENCIES = {
  '160m': 1843000,
  '80m': 3578000,
  '40m': 7080000,
  '30m': 10142000,
  '20m': 14063000,
  '17m': 18098000,
  '15m': 21063000,
  '12m': 24924000,
  '10m': 28063000,
  '6m': 50286000,
};
const HELL_DEFAULT_TONE_HZ = 1000;
const HELL_MIN_TONE_HZ = 300; // same limits as the server (audio/hell-rx.js)
const HELL_MAX_TONE_HZ = 2700;

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
// In WSPR the power menu offers 1-5 W (the server holds the radio at 5 W or
// less while WSPR is on, and puts the earlier power back afterwards).
const WSPR_POWER_OPTIONS = [5, 4, 3, 2, 1].map((watts) => ({ label: `${watts}W`, watts }));
let txPowerOptions = TX_POWER_OPTIONS;

// WSPR dial frequencies (USB; the signals are 1400-1600 Hz up). Kept the
// same as WSPR_DIAL_HZ in server/wspr-bridge.js.
const WSPR_FREQUENCIES = {
  '160m': 1836600,
  '80m': 3568600,
  '40m': 7038600,
  '30m': 10138700,
  '20m': 14095600,
  '17m': 18104600,
  '15m': 21094600,
  '12m': 24924600,
  '10m': 28124600,
  '6m': 50293000,
};
const WSPR_TX_HZ_RANGE = [1410, 1590];
const WSPR_MAX_ROWS = 100;

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
const audioFormatBtn = document.getElementById('audio-format-btn');
const tunerBtn = document.getElementById('tuner-btn');
const tuneBtn = document.getElementById('tune-btn');
const txPowerSelect = document.getElementById('tx-power-select');
const rxGainSlider = document.getElementById('rx-gain-slider');
const pttBtn = document.getElementById('ptt-btn');
const pttHintEl = document.getElementById('ptt-hint');
const ttyComposerEl = document.getElementById('tty-composer');
const ttyInputEl = document.getElementById('tty-input');
const ttySendBtn = document.getElementById('tty-send-btn');
const ttyStatusEl = document.getElementById('tty-status');
const ttyFreqLabelEl = document.getElementById('tty-freq-label');
const ttyFreqEl = document.getElementById('tty-freq');
const jttyRxEl = document.getElementById('jtty-rx');
const jttyTableBodyEl = document.getElementById('jtty-table-body');
const oliviaRxEl = document.getElementById('olivia-rx');
const sstvRxEl = document.getElementById('sstv-rx');
const faxRxEl = document.getElementById('fax-rx');
const faxViewEl = document.getElementById('fax-view');
const faxCanvas = document.getElementById('fax-canvas');
const faxStationsEl = document.getElementById('fax-stations');
const faxStationsListEl = document.getElementById('fax-stations-list');
const faxStatusEl = document.getElementById('fax-status');
const faxStartBtn = document.getElementById('fax-start-btn');
const faxStopBtn = document.getElementById('fax-stop-btn');
const faxSaveBtn = document.getElementById('fax-save-btn');
const faxStripEl = document.getElementById('fax-strip');
const scopeCanvasesEl = document.querySelector('.scope__canvases');
const scopeHeadingEl = document.querySelector('.scope__range .row-group__label');
const sstvStatusEl = document.getElementById('sstv-status');
const sstvCanvas = document.getElementById('sstv-canvas');
const sstvStripEl = document.getElementById('sstv-strip');
const sstvStopBtn = document.getElementById('sstv-stop-btn');
const sstvSaveBtn = document.getElementById('sstv-save-btn');
const oliviaRxTextEl = document.getElementById('olivia-rx-text');
const hellRxEl = document.getElementById('hell-rx');
const hellRxTextEl = document.getElementById('hell-rx-text');
const oliviaSignalEl = document.getElementById('olivia-signal');
const oliviaTuneBtn = document.getElementById('olivia-tune-btn');
const cwPaddleEl = document.getElementById('cw-paddle');
const cwDotBtn = document.getElementById('cw-dot-btn');
const cwDashBtn = document.getElementById('cw-dash-btn');
const cwWpmInput = document.getElementById('cw-wpm-input');
const cwComposerEl = document.getElementById('cw-composer');
const cwTextInput = document.getElementById('cw-text-input');
const cwSendBtn = document.getElementById('cw-send-btn');
const cwStatusEl = document.getElementById('cw-status');
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
const wsprPanelEl = document.getElementById('wspr-panel');
const wsprTableBodyEl = document.getElementById('wspr-table-body');
const wsprSlotEl = document.getElementById('wspr-slot');
const wsprTxEnabledEl = document.getElementById('wspr-tx-enabled');
const wsprTxHzEl = document.getElementById('wspr-tx-hz');
const wsprTxMsgEl = document.getElementById('wspr-tx-msg');
const wsprStatusEl = document.getElementById('wspr-status');
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
// Chimes when an FT8/FT4 station calls us (see call-alert.js).
const callAlert = new CallAlert();
/** A decoded message addressed to this station. */
function isToMe(msg) {
  if (!stationCallsign) return false;
  const [to, from] = String(msg?.msg || '').trim().toUpperCase().split(/\s+/);
  return to !== 'CQ' && !!from && baseCall(to) === baseCall(stationCallsign) && baseCall(from) !== baseCall(stationCallsign);
}

// --- WSPR state ---
// The third DIGI choice: app-level on USB + DATA MODE like FT8. The server
// keeps WSPR's state (EVENT.WSPR_STATUS); this page only shows it.
let wsprActive = false;
let wsprStatus = null;
let wsprLastBandName = null;

// --- JTTY state ---
// Like ft8Active, JTTY is an app-level concept layered on USB + DATA MODE
// (the radio has no JTTY mode), tracked independently of
// updateModeButtons()'s hardware-mode bookkeeping. RTTY, by contrast, is
// an ordinary CI-V mode — see ttyMode().
let jttyActive = false;
let jttyUsbSeen = false; // true once the radio has confirmed USB after JTTY was entered; see updateModeButtons()
// Olivia 8/250: the third TTY mode, app-level on USB + DATA MODE like JTTY.
let oliviaActive = false;
let oliviaUsbSeen = false;
let oliviaLastOffsetHz = 0; // the latest decoded signal's offset from the centre (for "Tune to signal")
// The frequency box is shared by JTTY (lowest tone), Olivia (centre) and Feld-Hell (tone); each keeps its own value.
// Feld-Hell: the fourth, also app-level on USB + DATA MODE. Nothing is decoded: the scope paints the picture.
let sstvActive = false; // the SSTV receiver is selected (on LSB/USB, no DATA MODE)
let sstvSidebandSeen = false;
let faxActive = false; // the radiofax receiver is selected (Image button on Fax; USB)
let faxUsbSeen = false;
let hellActive = false;
let hellUsbSeen = false;
const ttyFreqByMode = { JTTY: 1450, OLIVIA: OLIVIA_DEFAULT_CENTRE_HZ, HELL: HELL_DEFAULT_TONE_HZ };
let ttyTxInFlight = false;
let ttyShownMode = null; // which TTY mode updateTtyUi() last laid the composer out for
let ttyLastDefaultText = ''; // the CQ text updateTtyUi() last pre-filled, so a later mode switch only replaces text the operator never touched

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
let cwDecoderVariant = 'CW3';

// Which CW decoders the CW chip offers. Only the DeepCW one ('CW3') for
// now, so the chip just reads "CW" and a second click does nothing. The
// other two are kept, server-side and here: to offer them again, put them
// back in this list (['CW1', 'CW2', 'CW3']) and the chip reads "CW 1" /
// "CW 2" / "CW 3" and cycles through them on a second click again.
const CW_DECODERS_IN_UI = ['CW3'];

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
  if (ft8ModeBtn) ft8ModeBtn.textContent = wsprActive ? 'WSPR' : ft8Active ? ft8Variant : 'DIGI';
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
  if (!cwModeBtn) return;
  if (CW_DECODERS_IN_UI.length < 2) cwModeBtn.textContent = 'CW';
  else cwModeBtn.textContent = cwDecoderVariant === 'CW2' ? 'CW 2' : cwDecoderVariant === 'CW3' ? 'CW 3' : 'CW 1';
}

/** The next decoder the CW chip offers (CW1 -> CW2 -> CW3 -> CW1 when all are in CW_DECODERS_IN_UI). */
function nextCwDecoderVariant(variant) {
  const i = CW_DECODERS_IN_UI.indexOf(variant);
  return CW_DECODERS_IN_UI[(i + 1) % CW_DECODERS_IN_UI.length];
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
link.addEventListener('audio-opus', (event) => {
  if (audioPipeline) audioPipeline.playOpus(event.detail);
});
link.addEventListener('audio-adpcm', (event) => {
  if (audioPipeline) audioPipeline.playAdpcm(event.detail);
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
    if (jttyActive && !ft8Active) {
      // JTTY: the click sets the transmit frequency (lowest tone), as tapping a decoded line does.
      setJttyTxFreq(hz);
      return;
    }
    if (oliviaActive && !ft8Active) {
      // Olivia: the click sets the centre frequency the receiver listens on and the next transmission uses.
      setOliviaCentre(hz);
      return;
    }
    if (hellActive && !ft8Active) {
      // Feld-Hell: the click sets the tone the picture is painted from and the next transmission uses.
      setHellTone(hz);
      return;
    }
    if (wsprActive) {
      // WSPR: the click sets the transmit audio frequency (1410-1590 Hz).
      setWsprTxHz(hz);
      return;
    }
    currentQsoFreqHz = hz;
    // Also persists as the new session default (see ft8DefaultTxFreqHz's
    // doc comment) — a manual pick should stick around as "where my CQs
    // go out" for the rest of the session, not just for one transmission.
    ft8DefaultTxFreqHz = hz;
    scopeDisplay.setQsoFreq(hz);
  },
});
link.addEventListener('scope-line', (event) => {
  if (ft8Active || wsprActive || jttyActive || oliviaActive || hellActive || sstvActive || faxActive) return; // audio-domain FFT spectrum takes over the display; see the 'ft8-spectrum' listener below
  scopeDisplay.pushLine(event.detail);
});
link.addEventListener('ft8-spectrum', (event) => {
  if (!ft8Active && !wsprActive && !jttyActive && !oliviaActive && !hellActive && !sstvActive) return;
  // The audio spectrum comes from the RX audio, not the radio's scope, so it
  // works with CIV_SCOPE_ENABLED off: don't leave the "scope not enabled"
  // notice over it (which would also hide the Feld-Hell picture).
  scopePlaceholder.hidden = true;
  scopeDisplay.pushAudioSpectrum(event.detail);
});
// Feld-Hell: the received picture, drawn in the waterfall area (see ScopeDisplay#pushHellColumns()).
link.addEventListener('hell-columns', (event) => {
  if (hellActive) scopeDisplay.pushHellColumns(event.detail);
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
  setSstvTxInfo(data.sstvTx);
  stationGrid = data.stationGrid || null;
  ft8Qso.configure({ myCall: stationCallsign, myGrid: stationGrid });
  if (data.frequency != null) updateFrequencyDisplay(data.frequency);
  if (data.ft8Variant) ft8Variant = data.ft8Variant;
  if (data.wspr) renderWsprStatus(data.wspr);
  // The app-level modes before the radio's mode, so a mode another browser
  // has left since this page last saw the server is dropped quietly rather
  // than "left" (which would turn DATA MODE off under whatever replaced it).
  syncAppModesOnConnect(data);
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
  // earlier '700E'/'RADE' toggle was removed). The app-level modes (FT8,
  // FreeDV, JTTY, Olivia, Feld-Hell, SSTV) were applied above, by
  // syncAppModesOnConnect().

  pttBtn.disabled = false;
  notesSendBtn.disabled = false;
  cwSendBtn.disabled = false;
  // The paddle's buttons start disabled in the page like PTT; nothing ever
  // enabled them, so DOT and DASH could never be pressed.
  cwDotBtn.disabled = false;
  cwDashBtn.disabled = false;
  renderNotes(data.notes); // no chime: nothing new, just what's there
  ttySendBtn.disabled = false;
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
        onMicFrame: (type, frame) => {
          if (pttActive) link.sendAudioFrame(frame, type);
        },
        onCodecError: (direction, err) => {
          console.warn(`Opus ${direction === 'rx' ? 'decoding' : 'encoding'} failed, using ADPCM:`, err);
          if (direction === 'rx') setAudioCodecs('adpcm', audioPipeline.txCodec);
          else renderAudioFormat();
        },
      });
    }
    speakerBtn.disabled = false;
    speakerBtn.title = '';
    serverAudioCodecs = data.audio.codecs || ['pcm'];
    serverOpusBitrate = data.audio.opusBitrate || 24000;
    // the server forgets each browser's format when it disconnects
    applyAudioFormat();
  } else {
    speakerBtn.disabled = true;
    speakerBtn.title = 'Audio is not configured on the server (AUDIO_RX_DEVICE unset)';
    audioFormatBtn.disabled = true;
    audioFormatBtn.title = speakerBtn.title;
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

// While an RTTY transmission is going out the server briefly puts the radio
// on LSB/USB + DATA MODE with the dial offset (AFSK; see audio/tty-bridge.js)
// and then back. Those passing mode and frequency changes are not shown, so
// the TTY panel stays put; the real state is read back when it ends.
let rttyAfskInFlight = false;
link.addEventListener('frequency', (event) => {
  if (!rttyAfskInFlight) updateFrequencyDisplay(event.detail.value);
});
link.addEventListener('mode', (event) => {
  if (!rttyAfskInFlight) updateModeButtons(event.detail.value.mode);
});
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
  if (wsprActive) checkWsprBandChange(hz);
  if (faxActive) renderFaxStations();
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
    // In WSPR: the band's WSPR dial frequency.
    if (wsprActive && WSPR_FREQUENCIES[band.name] != null) {
      tuneWsprToBand(band.name);
      return;
    }
    // Likewise in JTTY: a band chip goes to that band's JTTY frequency.
    if (jttyActive && JTTY_FREQUENCIES[band.name] != null) {
      tuneJttyToBand(band.name);
      return;
    }
    // And in Olivia: the band's Olivia calling frequency.
    if (oliviaActive && OLIVIA_FREQUENCIES[band.name] != null) {
      tuneOliviaToBand(band.name);
      return;
    }
    // In SSTV: the band's SSTV frequency, on the band's sideband.
    if (sstvActive) {
      tuneSstvTo(SSTV_FREQUENCIES[band.name] ?? band.hz, band.name);
      return;
    }
    // In RTTY: the middle of the band's WIA digital segment.
    if (ttyMode() === 'RTTY' && RTTY_FREQUENCIES[band.name] != null) {
      tuneRttyToBand(band.name);
      return;
    }
    // And in Feld-Hell: the band's Feld-Hell activity frequency.
    if (hellActive && HELL_FREQUENCIES[band.name] != null) {
      tuneHellToBand(band.name);
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
let ttyModeBtn = null;
let ssbModeBtn = null;
let sstvModeBtn = null;
for (const entry of MODE_CHIPS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = entry;

  if (entry === 'SSB') {
    ssbModeBtn = btn;
    btn.addEventListener('click', () => {
      // A click while already in LSB/USB (and no app-level mode) flips the
      // sideband; otherwise it selects the usual one for the band.
      const inSsb = (currentMode === 'LSB' || currentMode === 'USB') && !appModeActive();
      const mode = inSsb ? (currentMode === 'LSB' ? 'USB' : 'LSB') : sidebandForFrequency(currentFreqHz ?? 14000000);
      exitAppModes();
      link
        .request('setMode', { mode })
        .then(() => updateModeButtons(mode))
        .catch((err) => showError(err.message));
    });
  } else if (entry === 'Image') {
    // SSTV, then Radiofax, then SSTV again (the chip reads "SSTV" or "Fax" while one is on).
    sstvModeBtn = btn;
    btn.addEventListener('click', () => {
      if (sstvActive) {
        exitSstvMode();
        enterFaxMode();
      } else if (faxActive) {
        exitFaxMode();
        enterSstvMode();
      } else {
        exitAppModes();
        enterSstvMode();
      }
    });
  } else if (entry === 'DIGI') {
    ft8ModeBtn = btn;
    // Starts on the neutral "FT8/FT4" label, matching what
    // updateFt8VariantUi() reverts to once the mode is left — see its
    // doc comment. (ft8Active is false at page load, so this could also
    // be written as a call to updateFt8VariantUi() here, but the literal
    // string keeps this loop from depending on ft8ModeBtn already being
    // assigned to itself mid-assignment.)
    btn.textContent = 'DIGI';
    btn.addEventListener('click', () => {
      // Explicitly picking FT8 always means "I'm not doing FreeDV right
      // now" — the two app-level pseudo-modes are mutually exclusive
      // (both just park the radio on USB + DATA MODE, so there's nothing
      // meaningful about "both at once"). See exitFreeDvMode()'s doc
      // comment.
      if (freeDvActive) exitFreeDvMode();
      if (jttyActive) exitJttyMode();
      if (oliviaActive) exitOliviaMode();
      if (hellActive) exitHellMode();
      if (sstvActive) exitSstvMode();
      if (faxActive) exitFaxMode();
      // First click enters FT8/FT4 mode (whichever variant was last
      // active, or 'FT8' the first time); a click while already active
      // toggles the protocol instead — see toggleFt8Variant()'s doc
      // comment for why this is the more useful behavior than a second
      // click doing nothing or re-entering the same mode.
      // ... and then on to WSPR: FT8 -> FT4 -> WSPR -> FT8.
      if (wsprActive) {
        exitWsprMode({ keepDataMode: true });
        if (ft8Variant !== 'FT8') {
          ft8Variant = 'FT8';
          link.request('setFt8Variant', { variant: 'FT8' }).catch((err) => showError(`Couldn't switch to FT8: ${err.message}`));
        }
        enterFt8Mode();
      } else if (!ft8Active) enterFt8Mode();
      else if (ft8Variant === 'FT8') toggleFt8Variant();
      else {
        exitFt8Mode({ keepDataMode: true });
        enterWsprMode();
      }
    });
  } else if (entry === 'FreeDV') {
    freeDvModeBtn = btn;
    btn.addEventListener('click', () => {
      // Mutual exclusivity with FT8 — see the FT8 click handler's mirror
      // comment above.
      if (ft8Active) exitFt8Mode();
      if (wsprActive) exitWsprMode();
      if (jttyActive) exitJttyMode();
      if (oliviaActive) exitOliviaMode();
      if (hellActive) exitHellMode();
      if (sstvActive) exitSstvMode();
      if (faxActive) exitFaxMode();
      // Unlike FT8, there's no second variant to toggle to any more (the
      // '700E' option was removed — see enterFreeDvMode()'s doc comment),
      // so a click while already active is simply a no-op.
      if (!freeDvActive) enterFreeDvMode();
    });
  } else if (entry === 'TTY') {
    ttyModeBtn = btn;
    btn.addEventListener('click', () => {
      // Same mutual exclusivity as the other app-level modes.
      if (ft8Active) exitFt8Mode();
      if (wsprActive) exitWsprMode();
      if (freeDvActive) exitFreeDvMode();
      if (sstvActive) exitSstvMode();
      if (faxActive) exitFaxMode();
      // First click selects RTTY; after that the button cycles RTTY ->
      // JTTY -> Olivia -> Feld-Hell -> RTTY ... until a non-TTY mode is
      // picked (which resets it to "TTY").
      const now = ttyMode();
      if (now === 'RTTY') enterJttyMode();
      else if (now === 'JTTY') switchJttyToOlivia();
      else if (now === 'OLIVIA') switchOliviaToHell();
      else selectRttyMode();
    });
  } else if (entry === 'CW') {
    cwModeBtn = btn;
    // Starts labeled for whichever decoder variant is currently selected
    // (CW3 by default, shown as plain "CW") — see updateCwVariantUi()'s doc comment for why,
    // unlike the FT8 chip, there's no neutral unselected label to fall
    // back to.
    updateCwVariantUi();
    btn.addEventListener('click', () => {
      if (ft8Active) exitFt8Mode();
      if (wsprActive) exitWsprMode();
      if (freeDvActive) exitFreeDvMode();
      if (jttyActive) exitJttyMode();
      if (oliviaActive) exitOliviaMode();
      if (hellActive) exitHellMode();
      if (sstvActive) exitSstvMode();
      if (faxActive) exitFaxMode();
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
      } else if (CW_DECODERS_IN_UI.length > 1) {
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
      if (wsprActive) exitWsprMode();
      if (freeDvActive) exitFreeDvMode();
      if (jttyActive) exitJttyMode();
      if (oliviaActive) exitOliviaMode();
      if (hellActive) exitHellMode();
      if (sstvActive) exitSstvMode();
      if (faxActive) exitFaxMode();
      link
        .request('setMode', { mode })
        .then(() => updateModeButtons(mode))
        .catch((err) => showError(err.message));
    });
    modeButtons.set(mode, btn);
  }

  modesEl.appendChild(btn);
}

/** True while one of the app-level modes layered on LSB/USB is selected. */
function appModeActive() {
  return ft8Active || wsprActive || freeDvActive || jttyActive || oliviaActive || hellActive || sstvActive || faxActive;
}

/** Leaves whichever app-level mode is selected (picking SSB or SSTV). */
function exitAppModes() {
  if (ft8Active) exitFt8Mode();
  if (wsprActive) exitWsprMode();
  if (freeDvActive) exitFreeDvMode();
  if (jttyActive) exitJttyMode();
  if (oliviaActive) exitOliviaMode();
  if (hellActive) exitHellMode();
  if (sstvActive) exitSstvMode();
  if (faxActive) exitFaxMode();
}

/**
 * Follows the app-level modes as the server has them (EVENT.APP_MODES, sent
 * when another browser changes one, or the connect snapshot), so every
 * browser shows the same mode. Only this page's display changes: the
 * browser that made the change has already set the radio and the server,
 * so nothing is sent back.
 */
function applyAppModes(s) {
  if (!s) return;
  // The audio frequencies first, so a mode entered below shows them.
  if (Number.isFinite(s.jttyTxHz)) ttyFreqByMode.JTTY = s.jttyTxHz;
  if (Number.isFinite(s.oliviaCentreHz)) ttyFreqByMode.OLIVIA = s.oliviaCentreHz;
  if (Number.isFinite(s.hellToneHz)) ttyFreqByMode.HELL = s.hellToneHz;
  // Whatever was switched off...
  if (!s.ft8Active) exitFt8Mode({ local: true });
  if (!s.wsprActive) exitWsprMode({ local: true });
  if (!s.freeDvActive) exitFreeDvMode({ local: true });
  if (!s.jttyActive) exitJttyMode({ local: true });
  if (!s.oliviaActive) exitOliviaMode({ local: true });
  if (!s.hellActive) exitHellMode({ local: true });
  if (!s.sstvActive) exitSstvMode({ local: true });
  if (!s.faxActive) exitFaxMode({ local: true });
  // ...then whatever was switched on.
  if (s.ft8Active) reflectFt8ActiveFromServer();
  if (s.wsprActive) reflectWsprActiveFromServer();
  if (s.freeDvActive) reflectFreeDvActiveFromServer();
  if (s.jttyActive) reflectJttyActiveFromServer();
  if (s.oliviaActive) reflectOliviaActiveFromServer(s.oliviaCentreHz);
  if (s.hellActive) reflectHellActiveFromServer(s.hellToneHz);
  if (s.sstvActive) reflectSstvActiveFromServer();
  if (s.faxActive) reflectFaxActiveFromServer();
  // A new audio frequency in the mode already shown (unless it's being typed here).
  const mode = ttyMode();
  if ((mode === 'JTTY' || mode === 'OLIVIA' || mode === 'HELL') && document.activeElement !== ttyFreqEl) {
    const hz = ttyFreqByMode[mode];
    if (Number(ttyFreqEl.value) !== hz) {
      ttyFreqEl.value = String(hz);
      scopeDisplay.setQsoFreq(hz);
    }
  }
}

link.addEventListener('app-modes', (event) => applyAppModes(event.detail));

/**
 * The app-level modes on (re)connecting. Normally the server's say goes
 * (another browser may have changed mode while this one was away). But if
 * the server has none at all while this page is still in one, and the radio
 * is still on that mode's sideband, the server has forgotten (it was
 * restarted, or every browser had gone, which stops the receivers): this
 * page carries on and re-arms it.
 */
function syncAppModesOnConnect(data) {
  const serverAny = data.ft8Active || data.wsprActive || data.freeDvActive || data.jttyActive || data.oliviaActive || data.hellActive || data.sstvActive || data.faxActive;
  const radio = data.mode?.mode;
  const fits = sstvActive || freeDvActive ? radio === 'LSB' || radio === 'USB' : radio === 'USB';
  if (!serverAny && appModeActive() && fits) {
    if (ft8Active) link.request('setFt8Active', { active: true }).catch(() => {});
    if (wsprActive) link.request('setWsprActive', { active: true }).catch(() => {});
    if (freeDvActive) link.request('setFreeDvActive', { active: true }).catch(() => {});
    if (jttyActive) link.request('setJttyActive', { active: true, txHz: ttyFreqByMode.JTTY }).catch(() => {});
    if (oliviaActive) link.request('setOliviaActive', { active: true, centreHz: ttyFreqByMode.OLIVIA }).catch(() => {});
    if (hellActive) link.request('setHellActive', { active: true, toneHz: ttyFreqByMode.HELL }).catch(() => {});
    if (sstvActive) link.request('setSstvActive', { active: true }).catch(() => {});
    if (faxActive) link.request('setFaxActive', { active: true }).catch(() => {});
    return;
  }
  applyAppModes(data);
}

/** The SSB chip reads "LSB"/"USB" and lights while the radio is on plain SSB, else "SSB". */
function updateSsbChip() {
  if (!ssbModeBtn) return;
  const on = (currentMode === 'LSB' || currentMode === 'USB') && !appModeActive();
  ssbModeBtn.textContent = on ? currentMode : 'SSB';
  ssbModeBtn.classList.toggle('chip--active', on);
  if (sstvModeBtn) {
    sstvModeBtn.classList.toggle('chip--active', sstvActive || faxActive);
    sstvModeBtn.textContent = sstvActive ? 'SSTV' : faxActive ? 'Fax' : 'Image';
  }
}

function updateModeButtons(mode) {
  currentMode = mode;
  for (const [name, btn] of modeButtons) {
    btn.classList.toggle('chip--active', name === mode);
  }
  // SSTV rides on LSB/USB like voice: if the radio is later put in any
  // other mode, SSTV is over (once LSB/USB has been confirmed, as for JTTY).
  if (sstvActive) {
    if (mode === 'LSB' || mode === 'USB') sstvSidebandSeen = true;
    else if (sstvSidebandSeen) leaveSstv();
  }
  // Radiofax is on USB: leaving USB (once confirmed) ends it.
  if (faxActive) {
    if (mode === 'USB') faxUsbSeen = true;
    else if (faxUsbSeen) leaveFax();
  }
  updateSsbChip();
  // JTTY runs on USB: if the radio is later reported in any other mode (a
  // front-panel change, say), JTTY is over. Ignored until USB has been
  // confirmed once, so a stale mode report that crosses with entering JTTY
  // can't cancel it.
  if (jttyActive) {
    if (mode === 'USB') jttyUsbSeen = true;
    else if (jttyUsbSeen) leaveJtty();
  }
  if (oliviaActive) {
    if (mode === 'USB') oliviaUsbSeen = true;
    else if (oliviaUsbSeen) leaveOlivia();
  }
  if (hellActive) {
    if (mode === 'USB') hellUsbSeen = true;
    else if (hellUsbSeen) leaveHell();
  }
  setCwPaddleVisible(mode === 'CW' && !ft8Active && !freeDvActive);
  setRttyTickerVisible(ttyMode() === 'RTTY');
  updateTtyUi();
}

// --- TTY mode (RTTY / JTTY / Olivia / Feld-Hell) ---

/**
 * Which TTY mode is currently in effect: 'JTTY' (app-level, on USB + DATA
 * MODE), 'RTTY' (the radio's own RTTY mode, and not secretly FT8/FreeDV),
 * or null. Everything TTY-related — the chip's label, the RTTY ticker, the
 * text entry/Send button replacing PTT — is derived from this one answer.
 */
function ttyMode() {
  if (jttyActive) return 'JTTY';
  if (oliviaActive) return 'OLIVIA';
  if (hellActive) return 'HELL';
  if (currentMode === 'RTTY' && !ft8Active && !wsprActive && !freeDvActive) return 'RTTY';
  return null;
}

/** TTY chip click while in JTTY or no TTY mode: select the radio's RTTY mode. */
function selectRttyMode() {
  link
    .request('setMode', { mode: 'RTTY' })
    .then(() => {
      // Then the middle of the band's WIA digital segment (RTTY_FREQUENCIES),
      // after the mode change so the radio shows it as the mark frequency.
      const bandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
      if (bandName) tuneRttyToBand(bandName);
      // Leaving JTTY, Olivia or Feld-Hell turns DATA MODE back off (see
      // leaveJtty() / leaveOlivia() / leaveHell()); done after the mode
      // change is confirmed so the chip never flickers via "TTY".
      leaveJtty();
      leaveOlivia();
      leaveHell();
      updateModeButtons('RTTY');
    })
    .catch((err) => showError(err.message));
}

/** Tunes to the centre of a band's WIA digital-modes segment (RTTY mark frequency). */
function tuneRttyToBand(bandName) {
  const hz = RTTY_FREQUENCIES[bandName];
  if (hz == null) return;
  link
    .request('setFrequency', { value: hz })
    .then(() => updateFrequencyDisplay(hz))
    .catch((err) => showError(`Couldn't tune to ${bandName} RTTY frequency: ${err.message}`));
}

/**
 * Enters JTTY: USB + DATA MODE (exactly as FT8 does — JTTY is audio-tone
 * modulation and needs the radio's data MOD-input path; see
 * enterFt8Mode()'s comments), no retune. Transmit only so far: nothing is
 * decoded.
 */
function enterJttyMode() {
  jttyActive = true; // updateTtyUi() below switches the scope to the audio spectrum
  jttyUsbSeen = false;
  // Tune to the standard JTTY frequency for the band the radio is on now
  // (left alone if the current frequency is outside the table's bands).
  const bandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
  if (bandName) tuneJttyToBand(bandName);
  link
    .request('setMode', { mode: 'USB' })
    .then(() => updateModeButtons('USB'))
    .catch((err) => showError(`Couldn't set USB for JTTY: ${err.message}`));
  link
    .request('setDataMode', { on: true })
    .catch((err) => showError(`Couldn't enable DATA MODE for JTTY: ${err.message}`));
  link
    .request('setJttyActive', { active: true, txHz: ttyFreqByMode.JTTY })
    .catch((err) => showError(`Couldn't start JTTY receive: ${err.message}`));
  setRttyTickerVisible(false);
  updateTtyUi();
}

/** Tunes to a band's standard JTTY dial frequency. */
function tuneJttyToBand(bandName) {
  const hz = JTTY_FREQUENCIES[bandName];
  if (hz == null) return;
  link
    .request('setFrequency', { value: hz })
    .then(() => updateFrequencyDisplay(hz))
    .catch((err) => showError(`Couldn't tune to ${bandName} JTTY frequency: ${err.message}`));
}

/**
 * Ends JTTY locally and restores DATA MODE. Returns false if JTTY wasn't
 * active. With `local`, only this page's display changes: another browser
 * left JTTY and has already put the radio and server right (see
 * applyAppModes()).
 */
function leaveJtty({ local = false } = {}) {
  if (!jttyActive) return false;
  jttyActive = false;
  jttyUsbSeen = false;
  if (local) return true;
  link.request('setDataMode', { on: false }).catch((err) => showError(`Couldn't disable DATA MODE: ${err.message}`));
  link.request('setJttyActive', { active: false }).catch(() => {});
  return true;
}

/**
 * JTTY was selected by another browser (or before this one connected, or
 * this one reconnected after the server forgot): reflect it locally without
 * re-sending the radio changes enterJttyMode() makes.
 */
function reflectJttyActiveFromServer() {
  if (jttyActive) return;
  jttyActive = true;
  jttyUsbSeen = false;
  setRttyTickerVisible(false);
  updateTtyUi();
}

/** Leaves JTTY because the operator (or, with `local`, another browser) picked some other mode. */
function exitJttyMode(opts) {
  if (!leaveJtty(opts)) return;
  updateTtyUi();
}

/**
 * TTY chip click while in JTTY: straight on to Olivia. Both run on USB with
 * DATA MODE on, so the radio's mode is left alone; only the receivers swap.
 */
function switchJttyToOlivia() {
  jttyActive = false;
  jttyUsbSeen = false;
  link.request('setJttyActive', { active: false }).catch(() => {});
  enterOliviaMode({ radioReady: true });
}

/**
 * Enters Olivia 8/250: USB + DATA MODE (unless already there, coming from
 * JTTY), the band's Olivia calling frequency, and the receiver armed at
 * the current centre frequency.
 */
function enterOliviaMode({ radioReady = false } = {}) {
  oliviaActive = true;
  oliviaUsbSeen = radioReady && currentMode === 'USB';
  const bandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
  if (bandName) tuneOliviaToBand(bandName);
  if (!radioReady) {
    link
      .request('setMode', { mode: 'USB' })
      .then(() => updateModeButtons('USB'))
      .catch((err) => showError(`Couldn't set USB for Olivia: ${err.message}`));
    link
      .request('setDataMode', { on: true })
      .catch((err) => showError(`Couldn't enable DATA MODE for Olivia: ${err.message}`));
  }
  link
    .request('setOliviaActive', { active: true, centreHz: ttyFreqByMode.OLIVIA })
    .catch((err) => showError(`Couldn't start Olivia receive: ${err.message}`));
  setRttyTickerVisible(false);
  updateTtyUi();
}

/** Tunes to a band's Olivia calling frequency. */
function tuneOliviaToBand(bandName) {
  const hz = OLIVIA_FREQUENCIES[bandName];
  if (hz == null) return;
  link
    .request('setFrequency', { value: hz })
    .then(() => updateFrequencyDisplay(hz))
    .catch((err) => showError(`Couldn't tune to ${bandName} Olivia frequency: ${err.message}`));
}

/** Ends Olivia locally and restores DATA MODE (not with `local`; see leaveJtty()). Returns false if Olivia wasn't active. */
function leaveOlivia({ local = false } = {}) {
  if (!oliviaActive) return false;
  oliviaActive = false;
  oliviaUsbSeen = false;
  if (local) return true;
  link.request('setDataMode', { on: false }).catch((err) => showError(`Couldn't disable DATA MODE: ${err.message}`));
  link.request('setOliviaActive', { active: false }).catch(() => {});
  return true;
}

/** Olivia was already selected when this page connected: reflect it without re-sending radio changes. */
function reflectOliviaActiveFromServer(centreHz) {
  if (Number.isFinite(centreHz)) ttyFreqByMode.OLIVIA = centreHz;
  if (oliviaActive) return;
  oliviaActive = true;
  oliviaUsbSeen = false;
  setRttyTickerVisible(false);
  updateTtyUi();
}

/** Leaves Olivia because the operator (or, with `local`, another browser) picked some other mode. */
function exitOliviaMode(opts) {
  if (!leaveOlivia(opts)) return;
  updateTtyUi();
}

/**
 * TTY chip click while in Olivia: on to Feld-Hell. Both run on USB with
 * DATA MODE on, so the radio's mode is left alone; the receivers swap and
 * the radio moves to the band's Feld-Hell frequency.
 */
function switchOliviaToHell() {
  oliviaActive = false;
  oliviaUsbSeen = false;
  link.request('setOliviaActive', { active: false }).catch(() => {});
  enterHellMode({ radioReady: true });
}

/**
 * Enters Feld-Hell: USB + DATA MODE (unless already there, coming from
 * Olivia), the band's Feld-Hell frequency, the receiver armed at the
 * current tone, and the scope's waterfall turned into the received picture.
 */
function enterHellMode({ radioReady = false } = {}) {
  hellActive = true;
  hellUsbSeen = radioReady && currentMode === 'USB';
  const bandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
  if (bandName) tuneHellToBand(bandName);
  if (!radioReady) {
    link
      .request('setMode', { mode: 'USB' })
      .then(() => updateModeButtons('USB'))
      .catch((err) => showError(`Couldn't set USB for Feld-Hell: ${err.message}`));
    link
      .request('setDataMode', { on: true })
      .catch((err) => showError(`Couldn't enable DATA MODE for Feld-Hell: ${err.message}`));
  }
  link
    .request('setHellActive', { active: true, toneHz: ttyFreqByMode.HELL })
    .catch((err) => showError(`Couldn't start Feld-Hell receive: ${err.message}`));
  setRttyTickerVisible(false);
  updateTtyUi();
}

/** Tunes so a signal on the band's Feld-Hell frequency comes out at the current audio tone. */
function tuneHellToBand(bandName) {
  const signalHz = HELL_FREQUENCIES[bandName];
  if (signalHz == null) return;
  const hz = signalHz - ttyFreqByMode.HELL;
  link
    .request('setFrequency', { value: hz })
    .then(() => updateFrequencyDisplay(hz))
    .catch((err) => showError(`Couldn't tune to ${bandName} Feld-Hell frequency: ${err.message}`));
}

/** Ends Feld-Hell locally and restores DATA MODE (not with `local`; see leaveJtty()). Returns false if Feld-Hell wasn't active. */
function leaveHell({ local = false } = {}) {
  if (!hellActive) return false;
  hellActive = false;
  hellUsbSeen = false;
  if (local) return true;
  link.request('setDataMode', { on: false }).catch((err) => showError(`Couldn't disable DATA MODE: ${err.message}`));
  link.request('setHellActive', { active: false }).catch(() => {});
  return true;
}

/** Feld-Hell was already selected when this page connected: reflect it without re-sending radio changes. */
function reflectHellActiveFromServer(toneHz) {
  if (Number.isFinite(toneHz)) ttyFreqByMode.HELL = toneHz;
  if (hellActive) return;
  hellActive = true;
  hellUsbSeen = false;
  setRttyTickerVisible(false);
  updateTtyUi();
}

/** Leaves Feld-Hell because the operator (or, with `local`, another browser) picked some other mode. */
function exitHellMode(opts) {
  if (!leaveHell(opts)) return;
  updateTtyUi();
}

/**
 * Enters SSTV receive: the band's SSTV frequency (if it has one) on the
 * band's sideband, the server's receiver armed, the picture panel shown and
 * the scope on the audio spectrum. Receive only, so DATA MODE is left off
 * and PTT stays the ordinary voice PTT.
 */
function enterSstvMode() {
  sstvActive = true;
  sstvSidebandSeen = false;
  const band = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
  tuneSstvTo(band && SSTV_FREQUENCIES[band] != null ? SSTV_FREQUENCIES[band] : currentFreqHz, band);
  link.request('setSstvActive', { active: true }).catch((err) => showError(`Couldn't start SSTV receive: ${err.message}`));
  loadSstvPictures();
  updateTtyUi();
}

/** Tunes to `hz` (if given) and puts the radio on the usual sideband for it. */
function tuneSstvTo(hz, bandName) {
  const target = hz ?? currentFreqHz ?? 14230000;
  const sideband = sidebandForFrequency(target);
  const setSideband = () =>
    link
      .request('setMode', { mode: sideband })
      .then(() => updateModeButtons(sideband))
      .catch((err) => showError(`Couldn't set ${sideband} for SSTV: ${err.message}`));
  if (hz == null) {
    setSideband();
    return;
  }
  link
    .request('setFrequency', { value: target })
    .then(() => {
      updateFrequencyDisplay(target);
      return setSideband();
    })
    .catch((err) => showError(`Couldn't tune to ${bandName ?? ''} SSTV frequency: ${err.message}`));
}

/** Ends SSTV locally (and, unless `local`, tells the server). Returns false if SSTV wasn't active. */
function leaveSstv({ local = false } = {}) {
  if (!sstvActive) return false;
  sstvActive = false;
  sstvSidebandSeen = false;
  if (!local) link.request('setSstvActive', { active: false }).catch(() => {});
  updateTtyUi();
  return true;
}

/** SSTV was already selected when this page connected: reflect it without retuning. */
function reflectSstvActiveFromServer() {
  if (sstvActive) return;
  sstvActive = true;
  sstvSidebandSeen = false;
  loadSstvPictures();
  updateTtyUi();
}

/** Leaves SSTV because the operator (or, with `local`, another browser) picked some other mode. */
function exitSstvMode(opts) {
  leaveSstv(opts);
}

const PTT_HINT_VOICE = 'Hold to transmit (or hold Space). First use will ask for microphone access.';
const PTT_HINT_CW =
  'Hold Dot/Dash to key CW (iambic — hold both to alternate). CI-V round-trip latency may make timing less precise than a hardware keyer.';
const TTY_HINT = {
  RTTY: 'Type your text and press Send (or Enter). Sent as AFSK RTTY, 45.45 baud / 170 Hz shift, on the same tones and Reverse setting as receive.',
  JTTY: 'Type your text and press Send (or Enter). Received JTTY appears above; tap a line to transmit on its frequency. The radio is on USB with DATA MODE on.',
  OLIVIA:
    'Type your text and press Send (or Enter). Olivia 8/250 sends about 1.5 characters a second. Received text appears above; click the spectrum to set the centre frequency (the receiver searches 125 Hz either side). The radio is on USB with DATA MODE on.',
  HELL:
    'Type your text and press Send (or Enter). Feld-Hell sends about 2.5 characters a second, drawn rather than coded. Received signals are painted in the scope as they arrive, and the text read from the picture appears below it (on weak signals, trust the picture). Click the spectrum on a signal to set the tone. The radio is on USB with DATA MODE on.',
};
const TTY_PLACEHOLDER = { RTTY: 'CQ CQ DE VK2IO K', JTTY: 'CQ VK2IO CQ', OLIVIA: 'CQ CQ CQ DE VK2IO VK2IO K', HELL: 'CQ CQ DE VK2IO VK2IO K' };
const TTY_MAX_CHARS = { RTTY: 200, JTTY: 80, OLIVIA: 300, HELL: 400 }; // Olivia/Feld-Hell: match OLIVIA_MAX_CHARS/HELL_MAX_CHARS in audio/tty-bridge.js
const TTY_CHIP_LABEL = { RTTY: 'RTTY', JTTY: 'JTTY', OLIVIA: 'Olivia', HELL: 'Feld-Hell' };
const TTY_FREQ_LABEL = { JTTY: 'TX audio', OLIVIA: 'Centre', HELL: 'Tone' };
const TTY_FREQ_RANGE = { JTTY: [200, 2800], OLIVIA: [OLIVIA_MIN_CENTRE_HZ, OLIVIA_MAX_CENTRE_HZ], HELL: [HELL_MIN_TONE_HZ, HELL_MAX_TONE_HZ] };
const TTY_FREQ_ARIA = {
  JTTY: 'JTTY transmit audio frequency in hertz',
  OLIVIA: 'Olivia centre audio frequency in hertz',
  HELL: 'Feld-Hell tone audio frequency in hertz',
};

/** The CQ text the composer starts a TTY session with (empty if STATION_CALLSIGN isn't configured). */
function ttyDefaultText(mode) {
  if (!stationCallsign) return '';
  if (mode === 'JTTY') return `CQ ${stationCallsign} CQ`;
  if (mode === 'OLIVIA') return `CQ CQ CQ DE ${stationCallsign} ${stationCallsign} K`;
  return `CQ CQ DE ${stationCallsign} ${stationCallsign} K`;
}

/**
 * Lays out the TTY chip and the PTT/text-entry area for whatever ttyMode()
 * now says. Idempotent — called at the end of updateModeButtons() and from
 * every place that changes ft8Active/freeDvActive/jttyActive. In RTTY or
 * JTTY the PTT button is replaced by a text field and a Send button (which
 * becomes Stop while a transmission runs); otherwise the usual PTT/CW
 * paddle layout is restored.
 */
function updateTtyUi() {
  if (!ttyModeBtn) return;
  const mode = ttyMode();
  ttyModeBtn.textContent = mode ? TTY_CHIP_LABEL[mode] : 'TTY';
  ttyModeBtn.classList.toggle('chip--active', mode !== null);
  ttyComposerEl.hidden = mode === null;
  const freqMode = mode === 'JTTY' || mode === 'OLIVIA' || mode === 'HELL';
  ttyFreqLabelEl.hidden = !freqMode;
  jttyRxEl.hidden = mode !== 'JTTY';
  oliviaRxEl.hidden = mode !== 'OLIVIA';
  hellRxEl.hidden = mode !== 'HELL';
  // JTTY, Olivia and Feld-Hell show the 0-3 kHz audio spectrum (like FT8/FT4), so the RF span buttons don't apply.
  scopeSpansEl.hidden = ft8Active || wsprActive || freqMode || sstvActive || faxActive;
  sstvRxEl.hidden = !sstvActive;
  // Radiofax: the chart replaces the spectrum, and the station buttons appear below the S-meter.
  faxRxEl.hidden = !faxActive;
  faxViewEl.hidden = !faxActive;
  faxStationsEl.hidden = !faxActive;
  scopeCanvasesEl.classList.toggle('scope__canvases--fax', faxActive);
  // no frequency axis for a chart; the scope heading says what it is
  scopeAxisEl.hidden = faxActive;
  scopeSection.classList.toggle('scope--fax', faxActive);
  scopeHeadingEl.textContent = faxActive ? 'Radiofax chart' : 'Spectrum scope';
  if (faxActive) {
    scopePlaceholder.hidden = true;
    renderFaxStations();
  }
  // SSTV: faint guides at the sync (1200 Hz), black (1500 Hz) and white (2300 Hz) tones.
  // WSPR: the edges of the 200 Hz WSPR window.
  scopeDisplay.setGuideFreqs(sstvActive ? [1200, 1500, 2300] : wsprActive ? [1400, 1600] : []);
  updateSsbChip();
  // Feld-Hell turns the waterfall into the received picture, scrolling right to left.
  scopeDisplay.setHellMode(mode === 'HELL');
  // Back on the RF scope: show its "not enabled" notice again if it applies
  // (it only has text once the server has said the scope is off).
  if (!ft8Active && !wsprActive && !freqMode && !sstvActive && !faxActive && scopePlaceholder.textContent) scopePlaceholder.hidden = scopeEnabled;
  if (freqMode) {
    ttyFreqLabelEl.firstChild.textContent = `${TTY_FREQ_LABEL[mode]} `;
    ttyFreqEl.min = String(TTY_FREQ_RANGE[mode][0]);
    ttyFreqEl.max = String(TTY_FREQ_RANGE[mode][1]);
    ttyFreqEl.setAttribute('aria-label', TTY_FREQ_ARIA[mode]);
    if (mode !== ttyShownMode) ttyFreqEl.value = String(ttyFreqByMode[mode]);
    scopeDisplay.setQsoFreq(Number(ttyFreqEl.value) || null);
  } else if (wsprActive) scopeDisplay.setQsoFreq(wsprStatus?.txHz ?? 1500);
  else if (!ft8Active) scopeDisplay.setQsoFreq(null);

  // RTTY and JTTY only carry capitals, so the box shows text that way; Olivia
  // and Feld-Hell send exactly what is typed (fldigi's Feld-Hell font draws
  // most, not all, lower-case letters as capitals), so it must show the real case.
  ttyInputEl.classList.toggle('tty-composer__input--as-typed', mode === 'OLIVIA' || mode === 'HELL');
  if (mode !== null) {
    pttBtn.hidden = true;
    pttHintEl.textContent = TTY_HINT[mode];
  } else if (ttyShownMode !== null) {
    // Just left TTY: hand the PTT button and hint back to the CW/voice layout.
    const cwVisible = currentMode === 'CW' && !ft8Active && !freeDvActive;
    pttBtn.hidden = cwVisible;
    pttHintEl.textContent = cwVisible ? PTT_HINT_CW : PTT_HINT_VOICE;
  }

  if (mode !== ttyShownMode) {
    ttyShownMode = mode;
    if (mode !== null) {
      ttyInputEl.placeholder = TTY_PLACEHOLDER[mode];
      ttyInputEl.maxLength = TTY_MAX_CHARS[mode];
      // Start each session ready to call CQ, but never clobber text the operator typed.
      if (ttyInputEl.value === '' || ttyInputEl.value === ttyLastDefaultText) {
        ttyLastDefaultText = ttyDefaultText(mode);
        ttyInputEl.value = ttyLastDefaultText;
      }
      ttyStatusEl.hidden = true;
    }
  }
}

/** Sets the JTTY transmit frequency (box, status line and the marker on the audio spectrum). */
function setJttyTxFreq(hz) {
  ttyFreqByMode.JTTY = Math.round(hz);
  ttyFreqEl.value = String(Math.round(hz));
  scopeDisplay.setQsoFreq(Math.round(hz));
  ttyStatusEl.hidden = false;
  ttyStatusEl.textContent = `JTTY transmit frequency set to ${Math.round(hz)} Hz.`;
  shareJttyTxFreq();
}

/** Tells the server (and so the other browsers) the JTTY transmit frequency. */
function shareJttyTxFreq() {
  if (jttyActive) link.request('setJttyActive', { active: true, txHz: ttyFreqByMode.JTTY }).catch(() => {});
}

/** Sets the Olivia centre frequency: the box, the spectrum marker, and the receiver (which retunes). */
function setOliviaCentre(hz, { quiet = false } = {}) {
  const centre = Math.max(OLIVIA_MIN_CENTRE_HZ, Math.min(OLIVIA_MAX_CENTRE_HZ, Math.round(hz)));
  ttyFreqByMode.OLIVIA = centre;
  ttyFreqEl.value = String(centre);
  scopeDisplay.setQsoFreq(centre);
  oliviaLastOffsetHz = 0;
  oliviaTuneBtn.hidden = true;
  if (oliviaActive) link.request('setOliviaActive', { active: true, centreHz: centre }).catch((err) => showError(`Couldn't retune Olivia: ${err.message}`));
  if (!quiet) {
    ttyStatusEl.hidden = false;
    ttyStatusEl.textContent = `Olivia centre set to ${centre} Hz (tones ${Math.round(centre - OLIVIA_HALF_SPAN_HZ)}–${Math.round(centre + OLIVIA_HALF_SPAN_HZ)} Hz; receiving ${centre - 125}–${centre + 125} Hz).`;
  }
}

/** Sets the Feld-Hell tone: the box, the spectrum marker, and the receiver (which retunes, keeping the picture). */
function setHellTone(hz, { quiet = false } = {}) {
  const tone = Math.max(HELL_MIN_TONE_HZ, Math.min(HELL_MAX_TONE_HZ, Math.round(hz)));
  ttyFreqByMode.HELL = tone;
  ttyFreqEl.value = String(tone);
  scopeDisplay.setQsoFreq(tone);
  if (hellActive) link.request('setHellActive', { active: true, toneHz: tone }).catch((err) => showError(`Couldn't retune Feld-Hell: ${err.message}`));
  if (!quiet) {
    ttyStatusEl.hidden = false;
    ttyStatusEl.textContent = `Feld-Hell tone set to ${tone} Hz (receiving about ${tone - 150}–${tone + 150} Hz).`;
  }
}

let oliviaRetuneTimer = null;
let hellRetuneTimer = null;
let jttyShareTimer = null;
ttyFreqEl.addEventListener('input', () => {
  const mode = ttyMode();
  const hz = Number(ttyFreqEl.value);
  if (mode === 'JTTY') {
    if (Number.isFinite(hz)) ttyFreqByMode.JTTY = hz;
    scopeDisplay.setQsoFreq(hz || null);
    clearTimeout(jttyShareTimer);
    if (Number.isFinite(hz) && hz >= TTY_FREQ_RANGE.JTTY[0] && hz <= TTY_FREQ_RANGE.JTTY[1]) jttyShareTimer = setTimeout(shareJttyTxFreq, 600);
  } else if (mode === 'OLIVIA') {
    scopeDisplay.setQsoFreq(hz || null);
    // Retune the receiver once typing pauses, not on every keystroke.
    clearTimeout(oliviaRetuneTimer);
    if (Number.isFinite(hz) && hz >= OLIVIA_MIN_CENTRE_HZ && hz <= OLIVIA_MAX_CENTRE_HZ) {
      oliviaRetuneTimer = setTimeout(() => setOliviaCentre(hz, { quiet: true }), 600);
    }
  } else if (mode === 'HELL') {
    scopeDisplay.setQsoFreq(hz || null);
    clearTimeout(hellRetuneTimer);
    if (Number.isFinite(hz) && hz >= HELL_MIN_TONE_HZ && hz <= HELL_MAX_TONE_HZ) {
      hellRetuneTimer = setTimeout(() => setHellTone(hz, { quiet: true }), 600);
    }
  }
});

/** Send button / Enter key: transmit the composer text, or cut a running transmission short. */
function sendTty() {
  const mode = ttyMode();
  if (!mode) return;
  if (ttyTxInFlight) {
    link.request('abortTty').catch((err) => showError(`Couldn't stop the transmission: ${err.message}`));
    return;
  }
  const text = ttyInputEl.value.trim();
  if (!text) return;
  const request = { mode, text };
  if (mode === 'JTTY' || mode === 'OLIVIA' || mode === 'HELL') {
    const freqHz = Number(ttyFreqEl.value);
    if (Number.isFinite(freqHz) && freqHz > 0) request.freqHz = freqHz;
  }
  link.request('sendTty', request).catch((err) => showError(`Couldn't send: ${err.message}`));
}
ttySendBtn.addEventListener('click', sendTty);
ttyInputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  if (!ttyTxInFlight) sendTty();
});

// --- JTTY receive ---
// One table row per message id, updated in place as frames arrive.
const JTTY_MAX_ROWS = 100;
const jttyRows = new Map(); // id -> row element

function utcClock(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

link.addEventListener('jtty-text', (event) => {
  const u = event.detail;
  if (!u || typeof u.id !== 'number' || typeof u.text !== 'string') return;
  let row = jttyRows.get(u.id);
  const stick = jttyTableBodyEl.parentElement.scrollTop + jttyTableBodyEl.parentElement.clientHeight >= jttyTableBodyEl.parentElement.scrollHeight - 8;
  if (!row) {
    row = document.createElement('div');
    row.className = 'ft8-table__row';
    row.setAttribute('role', 'row');
    for (let i = 0; i < 4; i++) row.appendChild(document.createElement('span'));
    row.addEventListener('click', () => {
      const hz = Number(row.dataset.freqHz);
      if (!Number.isFinite(hz)) return;
      setJttyTxFreq(hz);
    });
    jttyRows.set(u.id, row);
    jttyTableBodyEl.appendChild(row);
    while (jttyTableBodyEl.children.length > JTTY_MAX_ROWS) {
      const oldest = jttyTableBodyEl.firstElementChild;
      for (const [id, el] of jttyRows) if (el === oldest) jttyRows.delete(id);
      oldest.remove();
    }
  }
  const cells = row.children;
  cells[0].textContent = utcClock(u.startTime ?? u.time);
  cells[1].textContent = Number.isFinite(u.freqHz) ? String(Math.round(u.freqHz)) : '';
  cells[2].textContent = Number.isFinite(u.snr) ? String(u.snr) : '';
  cells[3].textContent = u.text;
  row.dataset.freqHz = String(u.freqHz);
  row.classList.toggle('jtty-table__row--live', u.status === 'growing');
  row.title = u.status === 'expired' ? 'Incomplete: the rest of this message was not received' : `${u.text} (${Math.round(u.freqHz)} Hz)`;
  if (stick) jttyTableBodyEl.parentElement.scrollTop = jttyTableBodyEl.parentElement.scrollHeight;
});

// --- Olivia receive ---
// Decoded text arrives a block (up to 3 characters) at a time, every ~2 s.
// It is shown as a running transcript, with this station's own
// transmissions shown inline so the conversation reads in order.
const OLIVIA_RX_MAX_CHARS = 4000;
function appendOliviaText(text, opts) {
  appendRxText(oliviaRxTextEl, text, opts);
}

/** A running receive transcript (Olivia, Feld-Hell), with this station's own transmissions inline. */
function appendRxText(box, text, { own = false } = {}) {
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  const clean = text.replace(/\r\n?/g, '\n');
  let last = box.lastElementChild;
  if (!last || last.classList.contains('olivia-rx__own') !== own) {
    if (own && box.textContent && !box.textContent.endsWith('\n')) box.appendChild(document.createTextNode('\n'));
    last = document.createElement('span');
    if (own) last.className = 'olivia-rx__own';
    box.appendChild(last);
  }
  // Backspace (sent by some keyboard-to-keyboard operators) removes the last character.
  for (const ch of clean) {
    if (ch === '\b') last.textContent = last.textContent.slice(0, -1);
    else last.textContent += ch;
  }
  while (box.textContent.length > OLIVIA_RX_MAX_CHARS && box.firstElementChild) {
    const first = box.firstElementChild;
    const excess = box.textContent.length - OLIVIA_RX_MAX_CHARS;
    if (first.textContent.length <= excess) first.remove();
    else first.textContent = first.textContent.slice(excess);
  }
  if (stick) box.scrollTop = box.scrollHeight;
}

// --- Feld-Hell text ---
// The server reads the received picture as text (audio/hell-ocr.js) and
// sends it a few seconds behind the picture; a page that has just connected
// is sent the recent text with replace: true.
link.addEventListener('hell-text', (event) => {
  const u = event.detail;
  if (!u || typeof u.text !== 'string') return;
  if (u.replace) hellRxTextEl.replaceChildren();
  appendRxText(hellRxTextEl, u.text);
});

link.addEventListener('olivia-text', (event) => {
  const u = event.detail;
  if (!u || typeof u.text !== 'string') return;
  appendOliviaText(u.text);
  oliviaLastOffsetHz = Number.isFinite(u.freqOffsetHz) ? u.freqOffsetHz : 0;
  const off = Math.round(oliviaLastOffsetHz);
  const offText = off === 0 ? 'on centre' : `${Math.abs(off)} Hz ${off > 0 ? 'above' : 'below'} centre`;
  oliviaSignalEl.textContent = `${utcClock(u.time ?? Date.now())} · S/N ${Number(u.snr).toFixed(1)} · ${offText}`;
  // The receiver copies anywhere within +/-125 Hz, but a reply should go out where the other station is.
  oliviaTuneBtn.hidden = Math.abs(off) < 16;
});
oliviaTuneBtn.addEventListener('click', () => {
  setOliviaCentre(ttyFreqByMode.OLIVIA + oliviaLastOffsetHz);
});

// --- SSTV receive ---
// While a picture comes in, its lines are drawn into the canvas as they
// arrive (uncorrected); when it ends, the slant-corrected PNG replaces them
// and joins the strip of recent pictures. Tap the picture to see it full
// size; Save downloads the one shown.
const SSTV_STRIP_MAX = 12;
let sstvCurrent = null; // {id, mode, name, width, lines, lineHeight, shiftHz, received}
let sstvShown = null; // the finished picture in the canvas: an EVENT.SSTV_PICTURE payload
const sstvSeen = new Set(); // picture ids already in the strip
const sstvCtx = sstvCanvas.getContext('2d');

function sstvSize(w, lines, lineHeight) {
  sstvCanvas.width = w;
  sstvCanvas.height = lines * (lineHeight || 1);
}

function sstvTime(ms) {
  return utcClock(ms).slice(0, 5);
}

function sstvPictureLine(p) {
  const shift = p.shiftHz ? ` · ${p.shiftHz > 0 ? '+' : ''}${p.shiftHz} Hz` : '';
  const done = p.complete ? '' : ` · cut short at line ${p.linesReceived}`;
  const who = p.own ? ' · sent' : p.fskId ? ` · ${p.fskId}` : '';
  return `${p.name} · ${p.width} × ${p.lines} · ${sstvTime(p.time)} UTC${who}${shift}${done}`;
}

function showSstvPicture(p) {
  const img = new Image();
  img.onload = () => {
    // a new picture started meanwhile, or ours is going out (it has the screen until it ends)
    if (sstvCurrent || sstvTxProgress) return;
    sstvSize(p.width, p.lines, p.lineHeight);
    sstvCtx.imageSmoothingEnabled = false;
    sstvCtx.drawImage(img, 0, 0, sstvCanvas.width, sstvCanvas.height);
  };
  img.src = `data:image/png;base64,${p.png}`;
  sstvShown = p;
  sstvSaveBtn.hidden = false;
  if (!sstvCurrent && !sstvTxProgress) sstvStatusEl.textContent = sstvPictureLine(p);
  for (const t of sstvStripEl.children) t.classList.toggle('sstv-rx__thumb--shown', Number(t.dataset.id) === p.id && Number(t.dataset.time) === p.time);
}

function addSstvThumb(p) {
  const key = `${p.id}:${p.time}`;
  if (sstvSeen.has(key)) return;
  sstvSeen.add(key);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sstv-rx__thumb';
  btn.dataset.id = String(p.id);
  btn.dataset.time = String(p.time);
  btn.title = sstvPictureLine(p);
  const img = document.createElement('img');
  img.alt = `${p.name}, ${sstvTime(p.time)} UTC`;
  img.src = `data:image/png;base64,${p.png}`;
  btn.appendChild(img);
  btn.addEventListener('click', () => showSstvPicture(p));
  sstvStripEl.prepend(btn);
  while (sstvStripEl.children.length > SSTV_STRIP_MAX) sstvStripEl.lastElementChild.remove();
}

function loadSstvPictures() {
  link
    .request('getSstvPictures')
    .then(({ pictures }) => {
      for (const p of pictures || []) addSstvThumb(p);
      if (!sstvShown && !sstvCurrent && pictures?.length) showSstvPicture(pictures[pictures.length - 1]);
    })
    .catch(() => {});
}

link.addEventListener('sstv-start', (event) => {
  const p = event.detail;
  sstvCurrent = { ...p, received: 0 };
  sstvShown = null;
  sstvSize(p.width, p.lines, p.lineHeight);
  sstvCtx.fillStyle = '#000';
  sstvCtx.fillRect(0, 0, sstvCanvas.width, sstvCanvas.height);
  sstvStopBtn.hidden = false;
  sstvSaveBtn.hidden = true;
  sstvStatusEl.textContent = `Receiving ${p.name} (${p.width} × ${p.lines})…`;
});

link.addEventListener('sstv-line', (event) => {
  const { id, y, width, rgb } = event.detail;
  const cur = sstvCurrent;
  if (!cur || cur.id !== id || width !== cur.width) return;
  const h = cur.lineHeight || 1;
  const row = sstvCtx.createImageData(width, h);
  for (let r = 0; r < h; r++) {
    for (let x = 0; x < width; x++) {
      const o = (r * width + x) * 4;
      row.data[o] = rgb[x * 3];
      row.data[o + 1] = rgb[x * 3 + 1];
      row.data[o + 2] = rgb[x * 3 + 2];
      row.data[o + 3] = 255;
    }
  }
  sstvCtx.putImageData(row, 0, y * h);
  cur.received = y + 1;
  const shift = cur.shiftHz ? ` · ${cur.shiftHz > 0 ? '+' : ''}${cur.shiftHz} Hz` : '';
  sstvStatusEl.textContent = `Receiving ${cur.name} · line ${y + 1} of ${cur.lines}${shift}`;
});

link.addEventListener('sstv-picture', (event) => {
  const p = event.detail;
  sstvCurrent = null;
  sstvStopBtn.hidden = true;
  addSstvThumb(p);
  showSstvPicture(p);
});

sstvStopBtn.addEventListener('click', () => {
  link.request('endSstvPicture').catch((err) => showError(`Couldn't stop the picture: ${err.message}`));
});

sstvSaveBtn.addEventListener('click', () => {
  const p = sstvShown;
  if (!p) return;
  const d = new Date(p.time);
  const pad = (n) => String(n).padStart(2, '0');
  const a = document.createElement('a');
  a.href = `data:image/png;base64,${p.png}`;
  a.download = `sstv-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}z-${p.mode}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// Full-size view: the picture at its own size (or the screen's), where the
// browser's pinch-zoom works; tap anywhere to close.
const sstvViewer = document.createElement('div');
sstvViewer.className = 'sstv-viewer';
sstvViewer.hidden = true;
const sstvViewerImg = document.createElement('img');
sstvViewerImg.alt = 'SSTV picture, full size';
sstvViewer.appendChild(sstvViewerImg);
document.body.appendChild(sstvViewer);
sstvViewer.addEventListener('click', () => {
  sstvViewer.hidden = true;
});
sstvCanvas.addEventListener('click', () => {
  const png = sstvCurrent ? null : sstvTxProgress?.png ?? sstvShown?.png;
  sstvViewerImg.src = png ? `data:image/png;base64,${png}` : sstvCanvas.toDataURL('image/png');
  sstvViewerImg.alt = 'SSTV picture, full size';
  sstvViewer.hidden = false;
});

// --- Radiofax (the Image button's second choice; see server/fax-decoder-bridge.js) ---
// The Bureau of Meteorology's HF radiofax: VMC (Charleville) and VMW
// (Wiluna), each on five frequencies, some only by day or night. Hours are
// UTC from bom.gov.au (vmc-technical-guide / vmw-technical-guide). The
// listed frequency is the signal's centre (1900 Hz up): the USB dial goes
// 1.9 kHz below it.
const FAX_STATIONS = [
  { call: 'VMC', site: 'Charleville', khz: 2628, from: 9, to: 19 },
  { call: 'VMC', site: 'Charleville', khz: 5100, from: 0, to: 24 },
  { call: 'VMC', site: 'Charleville', khz: 11030, from: 0, to: 24 },
  { call: 'VMC', site: 'Charleville', khz: 13920, from: 0, to: 24 },
  { call: 'VMC', site: 'Charleville', khz: 20469, from: 19, to: 9 },
  { call: 'VMW', site: 'Wiluna', khz: 5755, from: 11, to: 21 },
  { call: 'VMW', site: 'Wiluna', khz: 7535, from: 0, to: 24 },
  { call: 'VMW', site: 'Wiluna', khz: 10555, from: 0, to: 24 },
  { call: 'VMW', site: 'Wiluna', khz: 15615, from: 0, to: 24 },
  { call: 'VMW', site: 'Wiluna', khz: 18060, from: 21, to: 11 },
];
const FAX_DIAL_OFFSET_HZ = 1900;
const FAX_STRIP_MAX = 6;
const faxDialHz = (st) => st.khz * 1000 - FAX_DIAL_OFFSET_HZ;
/** On the air at UTC hour h (from/to wrap past midnight). */
const faxOnAir = (st, h) => (st.from === 0 && st.to === 24) || (st.from < st.to ? h >= st.from && h < st.to : h >= st.from || h < st.to);
const pad2 = (n) => String(n).padStart(2, '0');
const faxHours = (st) => (st.from === 0 && st.to === 24 ? '24 h' : `${pad2(st.from)}–${pad2(st.to)}Z`);
/** By time schedule: the hour each starts (all-day ones first), then frequency. */
const FAX_STATIONS_SORTED = [...FAX_STATIONS].sort((a, b) => (a.to - a.from === 24 ? -1 : a.from) - (b.to - b.from === 24 ? -1 : b.from) || a.khz - b.khz);

let faxCurrent = null; // the chart coming in: {id, width, lines}
let faxShown = null; // the finished chart on screen
const faxCtx = faxCanvas.getContext('2d');
const faxSeen = new Set();
let faxFollow = true; // keep the newest line in view unless the operator scrolled up

function renderFaxStations() {
  const h = new Date().getUTCHours();
  const key = `${h}:${currentFreqHz}`;
  if (faxStationsListEl.dataset.key === key) return;
  faxStationsListEl.dataset.key = key;
  faxStationsListEl.innerHTML = '';
  for (const st of FAX_STATIONS_SORTED) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const on = faxOnAir(st, h);
    btn.className = `chip fax-station${currentFreqHz === faxDialHz(st) ? ' chip--active' : ''}${on ? '' : ' fax-station--off-air'}`;
    btn.dataset.khz = String(st.khz);
    btn.title = `${st.call} ${st.site}, ${st.khz} kHz (dial ${(faxDialHz(st) / 1000).toFixed(1)} kHz USB), ${faxHours(st)}${on ? '' : ' — not on the air now'}`;
    const f = document.createElement('span');
    f.className = 'fax-station__freq';
    f.textContent = `${st.call} ${st.khz}`;
    const hrs = document.createElement('span');
    hrs.className = 'fax-station__hours';
    hrs.textContent = faxHours(st);
    btn.append(f, hrs);
    btn.addEventListener('click', () => tuneFax(st));
    faxStationsListEl.appendChild(btn);
  }
}
setInterval(() => faxActive && renderFaxStations(), 60000);

function tuneFax(st) {
  const hz = faxDialHz(st);
  link
    .request('setFrequency', { value: hz })
    .then(() => {
      updateFrequencyDisplay(hz);
      if (currentMode !== 'USB') return link.request('setMode', { mode: 'USB' }).then(() => updateModeButtons('USB'));
      return null;
    })
    .catch((err) => showError(`Couldn't tune to ${st.call} ${st.khz}: ${err.message}`));
}

/**
 * Radiofax receive: USB, the receiver armed, the chart in place of the
 * spectrum and the VMC/VMW buttons below the S-meter. If the radio isn't on
 * one of their frequencies already, the first on the air now (in the
 * buttons' order) is tuned. Receive only: no DATA MODE.
 */
function enterFaxMode() {
  faxActive = true;
  faxUsbSeen = false;
  const h = new Date().getUTCHours();
  const onOne = FAX_STATIONS.some((st) => faxDialHz(st) === currentFreqHz);
  if (!onOne) tuneFax(FAX_STATIONS_SORTED.find((st) => faxOnAir(st, h)) ?? FAX_STATIONS_SORTED[0]);
  else link.request('setMode', { mode: 'USB' }).then(() => updateModeButtons('USB')).catch((err) => showError(err.message));
  link.request('setFaxActive', { active: true }).catch((err) => showError(`Couldn't start radiofax receive: ${err.message}`));
  loadFaxPictures();
  updateTtyUi();
}

function leaveFax({ local = false } = {}) {
  if (!faxActive) return false;
  faxActive = false;
  faxUsbSeen = false;
  if (!local) link.request('setFaxActive', { active: false }).catch(() => {});
  updateTtyUi();
  return true;
}

function reflectFaxActiveFromServer() {
  if (faxActive) return;
  faxActive = true;
  faxUsbSeen = false;
  loadFaxPictures();
  updateTtyUi();
}

function exitFaxMode(opts) {
  leaveFax(opts);
}

/** Makes the chart canvas at least `lines` tall, keeping what is drawn. */
function faxEnsureHeight(width, lines) {
  if (faxCanvas.width === width && faxCanvas.height >= lines) return;
  const keep = faxCanvas.width === width ? faxCtx.getImageData(0, 0, faxCanvas.width, faxCanvas.height) : null;
  faxCanvas.width = width;
  faxCanvas.height = Math.max(lines, keep ? keep.height * 2 : 1);
  faxCtx.fillStyle = '#fff';
  faxCtx.fillRect(0, 0, faxCanvas.width, faxCanvas.height);
  if (keep) faxCtx.putImageData(keep, 0, 0);
}

function faxScroll(lines) {
  if (!faxFollow) return;
  // the drawn part only: the canvas may be taller than the chart so far
  const scale = faxViewEl.clientWidth / faxCanvas.width;
  faxViewEl.scrollTop = Math.max(0, lines * scale - faxViewEl.clientHeight);
}
faxViewEl.addEventListener('scroll', () => {
  const scale = faxViewEl.clientWidth / faxCanvas.width;
  const drawn = (faxCurrent?.lines ?? faxCanvas.height) * scale;
  faxFollow = faxViewEl.scrollTop + faxViewEl.clientHeight >= drawn - 8;
});

function faxStatusText(s) {
  if (!s) return '';
  const clock = s.clockPpm ? ` · clock ${s.clockPpm > 0 ? '+' : ''}${s.clockPpm} ppm` : '';
  switch (s.state) {
    case 'listening':
      return 'Listening for a start signal… (Start now to begin a chart already under way)';
    case 'phasing':
      return 'Start signal heard: lining up on the phasing lines…';
    case 'receiving':
      return `Receiving a chart · line ${faxCurrent?.lines ?? s.lines}${clock}`;
    default:
      return 'Radiofax receiver off.';
  }
}

function faxPictureLine(p) {
  const d = new Date(p.time);
  const mins = Math.round((p.endTime - p.time) / 60000);
  const how = p.complete ? '' : ` · ended by ${p.reason}`;
  const fixed = p.slantPxPerLine ? ' · slant corrected' : '';
  return `Chart · ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC · ${p.lines} lines (${mins} min)${p.phased ? '' : ' · started by hand'}${fixed}${how}`;
}

function showFaxPicture(p) {
  const img = new Image();
  img.onload = () => {
    if (faxCurrent) return; // a new chart has the screen
    faxCanvas.width = p.width;
    faxCanvas.height = p.lines;
    faxCtx.drawImage(img, 0, 0);
    faxFollow = true;
    faxViewEl.scrollTop = 0;
  };
  img.src = `data:image/png;base64,${p.png}`;
  faxShown = p;
  faxSaveBtn.hidden = false;
  if (!faxCurrent) faxStatusEl.textContent = faxPictureLine(p);
  for (const t of faxStripEl.children) t.classList.toggle('sstv-rx__thumb--shown', t.dataset.key === `${p.id}:${p.time}`);
}

function addFaxThumb(p) {
  const key = `${p.id}:${p.time}`;
  if (faxSeen.has(key)) return;
  faxSeen.add(key);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sstv-rx__thumb';
  btn.dataset.key = key;
  btn.title = faxPictureLine(p);
  const img = document.createElement('img');
  img.alt = faxPictureLine(p);
  img.src = `data:image/png;base64,${p.png}`;
  btn.appendChild(img);
  btn.addEventListener('click', () => showFaxPicture(p));
  faxStripEl.prepend(btn);
  while (faxStripEl.children.length > FAX_STRIP_MAX) faxStripEl.lastElementChild.remove();
}

function loadFaxPictures() {
  link
    .request('getFaxPictures')
    .then(({ pictures, current }) => {
      for (const p of pictures || []) addFaxThumb(p);
      if (current) {
        // a chart is coming in: show it so far, and the lines that follow add to it
        faxCurrent = { id: current.id, width: current.width, lines: current.linesSoFar ?? 0 };
        faxFollow = true;
        faxEnsureHeight(current.width, Math.max(600, faxCurrent.lines + 200));
        faxStopBtn.hidden = false;
        if (current.png) {
          const img = new Image();
          img.onload = () => {
            faxCtx.drawImage(img, 0, 0);
            faxScroll(faxCurrent?.lines ?? 0);
          };
          img.src = `data:image/png;base64,${current.png}`;
        }
      } else if (!faxShown && pictures?.length) showFaxPicture(pictures[pictures.length - 1]);
    })
    .catch(() => {});
}

link.addEventListener('fax-status', (event) => {
  if (!faxCurrent || event.detail.state !== 'receiving') faxStatusEl.textContent = faxStatusText(event.detail);
  faxStartBtn.hidden = event.detail.state === 'receiving';
});

link.addEventListener('fax-start', (event) => {
  const p = event.detail;
  faxCurrent = { id: p.id, width: p.width, lines: 0, clockPpm: p.clockPpm };
  faxShown = null;
  faxFollow = true;
  faxCanvas.width = 1; // start afresh
  faxEnsureHeight(p.width, 600);
  faxViewEl.scrollTop = 0;
  faxStopBtn.hidden = false;
  faxStartBtn.hidden = true;
  faxSaveBtn.hidden = true;
  faxStatusEl.textContent = p.phased ? 'Receiving a chart…' : 'Receiving a chart (started by hand)…';
});

link.addEventListener('fax-line', (event) => {
  const { id, y, width, grey } = event.detail;
  const cur = faxCurrent;
  if (!cur || cur.id !== id || width !== cur.width) return;
  faxEnsureHeight(width, y + 1);
  const row = faxCtx.createImageData(width, 1);
  for (let x = 0; x < width; x++) {
    const o = x * 4;
    row.data[o] = row.data[o + 1] = row.data[o + 2] = grey[x];
    row.data[o + 3] = 255;
  }
  faxCtx.putImageData(row, 0, y);
  cur.lines = y + 1;
  faxScroll(cur.lines);
  const clock = cur.clockPpm ? ` · clock ${cur.clockPpm > 0 ? '+' : ''}${cur.clockPpm} ppm` : '';
  faxStatusEl.textContent = `Receiving a chart · line ${y + 1}${clock}`;
});

link.addEventListener('fax-picture', (event) => {
  const p = event.detail;
  faxCurrent = null;
  faxStopBtn.hidden = true;
  faxStartBtn.hidden = false;
  addFaxThumb(p);
  showFaxPicture(p);
});

faxStartBtn.addEventListener('click', () => {
  link.request('faxStartNow').catch((err) => showError(`Couldn't start a chart: ${err.message}`));
});
faxStopBtn.addEventListener('click', () => {
  link.request('faxStop').catch((err) => showError(`Couldn't stop the chart: ${err.message}`));
});
faxSaveBtn.addEventListener('click', () => {
  const p = faxShown;
  if (!p) return;
  const d = new Date(p.time);
  const a = document.createElement('a');
  a.href = `data:image/png;base64,${p.png}`;
  a.download = `fax-${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}z.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});
// Full size: the same viewer as SSTV (pinch-zoom works there; tap to close).
faxCanvas.addEventListener('click', () => {
  sstvViewerImg.src = !faxCurrent && faxShown ? `data:image/png;base64,${faxShown.png}` : faxCanvas.toDataURL('image/png');
  sstvViewerImg.alt = 'Radiofax chart, full size';
  sstvViewer.hidden = false;
});

// --- SSTV transmit ---
// Take a photo (the phone's camera) or choose an image, crop it to the
// server's SSTV_TX_MODE shape by dragging and zooming, tag it with the
// callsign (and an optional second line) in a corner, and send it. The
// tag, with its backing box, is kept within half the picture's width and
// half its height (it was a quarter of each until v81; doubled on request). The FSK ID and CW ID are added by the
// server.
const sstvTxEl = document.getElementById('sstv-tx');
const sstvTxEditor = document.getElementById('sstv-tx-editor');
const sstvTxCanvas = document.getElementById('sstv-tx-canvas');
const sstvTxCtx = sstvTxCanvas.getContext('2d');
const sstvTxZoom = document.getElementById('sstv-tx-zoom');
const sstvTxCall = document.getElementById('sstv-tx-call');
const sstvTxLine2 = document.getElementById('sstv-tx-line2');
const sstvTxCorner = document.getElementById('sstv-tx-corner');
const sstvTxSendBtn = document.getElementById('sstv-tx-send');
const sstvTxStatus = document.getElementById('sstv-tx-status');
const sstvCameraInput = document.getElementById('sstv-camera-input');
const sstvFileInput = document.getElementById('sstv-file-input');
let sstvTxInfo = null; // the connect snapshot's sstvTx: {mode, name, width, lines, lineHeight, durationSec, fskId, cwId}
let sstvTxImage = null; // the chosen picture (ImageBitmap or <img>)
const sstvCrop = { cx: 0, cy: 0, zoom: 1 };
let sstvTxBusy = false;
let sstvTxTimer = null;

const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function sstvTxSize() {
  return { W: sstvTxInfo.width, H: sstvTxInfo.lines * (sstvTxInfo.lineHeight || 1) };
}

function updateSstvTxSendLabel() {
  if (!sstvTxInfo || sstvTxBusy) return;
  sstvTxSendBtn.textContent = `Send (${sstvTxInfo.name}, ${mmss(sstvTxInfo.durationSec)})`;
}

/** Called with the connect snapshot. */
function setSstvTxInfo(info) {
  sstvTxInfo = info || null;
  sstvTxEl.hidden = !sstvTxInfo;
  if (sstvTxInfo && !sstvTxCall.value) sstvTxCall.value = stationCallsign || '';
  updateSstvTxSendLabel();
}

/** The picture as it will be sent: scaled to cover the frame, cropped, then tagged. */
function drawSstvTx() {
  if (!sstvTxInfo || !sstvTxImage) return;
  const { W, H } = sstvTxSize();
  sstvTxCanvas.width = W;
  sstvTxCanvas.height = H;
  const iw = sstvTxImage.width;
  const ih = sstvTxImage.height;
  const scale = Math.max(W / iw, H / ih) * sstvCrop.zoom;
  const hw = W / scale / 2;
  const hh = H / scale / 2;
  sstvCrop.cx = Math.min(iw - hw, Math.max(hw, sstvCrop.cx));
  sstvCrop.cy = Math.min(ih - hh, Math.max(hh, sstvCrop.cy));
  sstvTxCtx.imageSmoothingEnabled = true;
  sstvTxCtx.imageSmoothingQuality = 'high';
  sstvTxCtx.drawImage(sstvTxImage, sstvCrop.cx - hw, sstvCrop.cy - hh, 2 * hw, 2 * hh, 0, 0, W, H);
  drawSstvTag(sstvTxCtx, W, H, sstvTxCall.value.trim().toUpperCase(), sstvTxLine2.value.trim(), sstvTxCorner.value);
}

/**
 * The callsign tag: bold white text with a dark outline on a translucent
 * box, in a corner, sized as large as fits in half the width and half the
 * height (box included). Returns the box drawn.
 */
function drawSstvTag(ctx, W, H, call, line2, corner) {
  if (!call && !line2) return null;
  const maxW = Math.floor(W / 2);
  const maxH = Math.floor(H / 2);
  const pad = Math.max(2, Math.round(Math.min(W, H) / 80));
  const font = (px) => `bold ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const ratio2 = 0.6; // second line size, relative to the callsign
  ctx.font = font(100);
  const w1 = call ? ctx.measureText(call).width : 0;
  const w2 = line2 ? ctx.measureText(line2).width * ratio2 : 0;
  const lines = (call ? 1 : 0) + (line2 ? ratio2 * 1.1 : 0);
  // the outline adds about size/8 on each side
  const k = Math.min((maxW - 2 * pad) / (Math.max(w1, w2) + 25), (maxH - 2 * pad) / (100 * lines + 25));
  const size = Math.max(4, Math.floor(100 * k));
  const boxW = Math.min(maxW, Math.ceil(k * (Math.max(w1, w2) + 25) + 2 * pad));
  const boxH = Math.min(maxH, Math.ceil(k * (100 * lines + 25) + 2 * pad));
  const m = pad; // margin from the picture's edge
  const x = corner.endsWith('r') ? W - boxW - m : m;
  const y = corner.startsWith('b') ? H - boxH - m : m;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';
  let ty = y + pad + Math.round(size / 16);
  if (call) {
    ctx.font = font(size);
    ctx.lineWidth = Math.max(1, size / 8);
    ctx.strokeText(call, x + boxW / 2, ty);
    ctx.fillText(call, x + boxW / 2, ty);
    ty += size;
  }
  if (line2) {
    const s2 = Math.max(4, Math.floor(size * ratio2));
    ctx.font = font(s2);
    ctx.lineWidth = Math.max(1, s2 / 8);
    ctx.strokeText(line2, x + boxW / 2, ty + s2 * 0.1);
    ctx.fillText(line2, x + boxW / 2, ty + s2 * 0.1);
  }
  ctx.restore();
  return { x, y, w: boxW, h: boxH };
}

async function loadSstvTxFile(file) {
  if (!file) return;
  try {
    let img;
    try {
      img = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('not an image this browser can read'));
        el.src = URL.createObjectURL(file);
      });
    }
    sstvTxImage = img;
    sstvCrop.cx = img.width / 2;
    sstvCrop.cy = img.height / 2;
    sstvCrop.zoom = 1;
    sstvTxZoom.value = '1';
    sstvTxEditor.hidden = false;
    sstvTxStatus.textContent = 'Drag to choose what is sent; pinch or use Zoom to get closer.';
    drawSstvTx();
  } catch (err) {
    showError(`Couldn't open that picture: ${err.message}`);
  }
}

document.getElementById('sstv-camera-btn').addEventListener('click', () => sstvCameraInput.click());
document.getElementById('sstv-file-btn').addEventListener('click', () => sstvFileInput.click());
for (const input of [sstvCameraInput, sstvFileInput]) {
  input.addEventListener('change', () => {
    loadSstvTxFile(input.files && input.files[0]);
    input.value = '';
  });
}
for (const el of [sstvTxCall, sstvTxLine2, sstvTxCorner]) el.addEventListener('input', drawSstvTx);
sstvTxZoom.addEventListener('input', () => {
  sstvCrop.zoom = Number(sstvTxZoom.value);
  drawSstvTx();
});

// Drag to move the crop; two fingers to zoom; the mouse wheel zooms too.
const sstvPointers = new Map();
let sstvPinch = null;
function sstvCanvasScale() {
  const { W } = sstvTxSize();
  const rect = sstvTxCanvas.getBoundingClientRect();
  const iw = sstvTxImage.width;
  const ih = sstvTxImage.height;
  const { H } = sstvTxSize();
  return (Math.max(W / iw, H / ih) * sstvCrop.zoom * rect.width) / W; // screen px per source px
}
function setSstvZoom(z) {
  sstvCrop.zoom = Math.min(4, Math.max(1, z));
  sstvTxZoom.value = String(sstvCrop.zoom);
  drawSstvTx();
}
sstvTxCanvas.addEventListener('pointerdown', (e) => {
  if (!sstvTxImage) return;
  sstvTxCanvas.setPointerCapture(e.pointerId);
  sstvPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (sstvPointers.size === 2) {
    const [a, b] = [...sstvPointers.values()];
    sstvPinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: sstvCrop.zoom };
  }
});
sstvTxCanvas.addEventListener('pointermove', (e) => {
  const p = sstvPointers.get(e.pointerId);
  if (!p || !sstvTxImage) return;
  if (sstvPointers.size === 1) {
    const s = sstvCanvasScale();
    sstvCrop.cx -= (e.clientX - p.x) / s;
    sstvCrop.cy -= (e.clientY - p.y) / s;
    drawSstvTx();
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (sstvPointers.size === 2 && sstvPinch) {
    const [a, b] = [...sstvPointers.values()];
    setSstvZoom((sstvPinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / sstvPinch.d);
  }
});
const sstvPointerUp = (e) => {
  sstvPointers.delete(e.pointerId);
  if (sstvPointers.size < 2) sstvPinch = null;
};
sstvTxCanvas.addEventListener('pointerup', sstvPointerUp);
sstvTxCanvas.addEventListener('pointercancel', sstvPointerUp);
sstvTxCanvas.addEventListener(
  'wheel',
  (e) => {
    if (!sstvTxImage) return;
    e.preventDefault();
    setSstvZoom(sstvCrop.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false }
);

// Cancel closes the editor; while a picture is going out it stops the
// transmission first (and closes once the server confirms).
let sstvCancelPending = false;
function closeSstvTxEditor() {
  sstvTxImage = null;
  sstvTxEditor.hidden = true;
}
document.getElementById('sstv-tx-cancel').addEventListener('click', () => {
  if (sstvTxBusy) {
    sstvCancelPending = true;
    sstvTxStatus.textContent = 'Stopping…';
    link.request('abortSstv').catch((err) => showError(`Couldn't stop the picture: ${err.message}`));
    return;
  }
  closeSstvTxEditor();
});

function sstvTxRgbBase64() {
  const { W, H } = sstvTxSize();
  const d = sstvTxCtx.getImageData(0, 0, W, H).data;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    rgb[j] = d[i];
    rgb[j + 1] = d[i + 1];
    rgb[j + 2] = d[i + 2];
  }
  let bin = '';
  for (let i = 0; i < rgb.length; i += 0x8000) bin += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
  return btoa(bin);
}

sstvTxSendBtn.addEventListener('click', () => {
  if (sstvTxBusy) {
    link.request('abortSstv').catch((err) => showError(`Couldn't stop the picture: ${err.message}`));
    return;
  }
  if (!sstvTxImage || !sstvTxInfo) return;
  drawSstvTx();
  const { W, H } = sstvTxSize();
  link.request('sendSstv', { rgb: sstvTxRgbBase64(), width: W, height: H }).catch((err) => showError(`Couldn't send: ${err.message}`));
});

// --- SSTV transmit progress ---
// Shown in every browser while a picture is being prepared or sent: a bar
// with elapsed / total time, marked where the picture ends and the FSK ID
// and CW ID begin, what is going out now (header, picture line n of N, the
// IDs) and the time left, and a Stop button. The picture fills in on the
// SSTV screen above as it goes out, the rest of it dimmed. Times are counted
// on this device from when the status arrived (elapsedSec), so the Pi's and
// the phone's clocks needn't agree.
const sstvTxProgressEl = document.getElementById('sstv-tx-progress');
const sstvTxProgressLabel = document.getElementById('sstv-tx-progress-label');
const sstvTxProgressTime = document.getElementById('sstv-tx-progress-time');
const sstvTxProgressDetail = document.getElementById('sstv-tx-progress-detail');
const sstvTxBar = document.getElementById('sstv-tx-bar');
const sstvTxBarFill = document.getElementById('sstv-tx-bar-fill');
let sstvTxProgress = null; // while sending: {name, t0, durationSec, timeline, lines, img, width, height, lastRow}

/** What is going out `t` seconds in: {label, line?, pictureFrac} */
function sstvTxPhase(t, p) {
  const tl = p.timeline;
  if (!tl) return { label: 'Sending', pictureFrac: Math.min(1, t / p.durationSec) };
  let a = tl.headerSec;
  if (t < a) return { label: 'VIS header', pictureFrac: 0 };
  if (t < a + tl.pictureSec) {
    const frac = (t - a) / tl.pictureSec;
    return { label: 'Picture', line: Math.min(p.lines, Math.floor(frac * p.lines) + 1), pictureFrac: frac };
  }
  a += tl.pictureSec;
  if (tl.fskSec && t < a + tl.fskSec) return { label: 'FSK ID', pictureFrac: 1 };
  a += tl.fskSec;
  if (tl.cwSec && t < a + tl.gapSec + tl.cwSec) return { label: 'CW ID', pictureFrac: 1 };
  return { label: 'Finishing', pictureFrac: 1 };
}

/** The bar's marks where the picture starts and ends (the IDs follow). */
function setSstvTxBarMarks(p) {
  for (const m of sstvTxBar.querySelectorAll('.sstv-tx__bar-mark')) m.remove();
  const tl = p?.timeline;
  if (!tl || !(p.durationSec > 0)) return;
  for (const s of [tl.headerSec, tl.headerSec + tl.pictureSec]) {
    if (s <= 0 || s >= p.durationSec - 0.05) continue;
    const mark = document.createElement('div');
    mark.className = 'sstv-tx__bar-mark';
    mark.style.left = `${(100 * s) / p.durationSec}%`;
    sstvTxBar.appendChild(mark);
  }
}

/** The picture on the SSTV screen, sent rows shown and the rest dimmed, with a line where it has got to. */
function drawSstvTxReveal(p, frac) {
  if (!p.img) return;
  const W = sstvCanvas.width;
  const H = sstvCanvas.height;
  const row = Math.round(Math.max(0, Math.min(1, frac)) * H);
  if (row === p.lastRow) return;
  p.lastRow = row;
  sstvCtx.imageSmoothingEnabled = false;
  sstvCtx.drawImage(p.img, 0, 0, W, H);
  if (row < H) {
    sstvCtx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    sstvCtx.fillRect(0, row, W, H - row);
    sstvCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--led-green').trim() || '#4fd67a';
    sstvCtx.fillRect(0, Math.min(row, H - 2), W, Math.max(2, Math.round(H / 128)));
  }
}

function tickSstvTxProgress() {
  const p = sstvTxProgress;
  if (!p) return;
  const t = Math.max(0, Math.min(p.durationSec, (Date.now() - p.t0) / 1000));
  const pct = p.durationSec > 0 ? (100 * t) / p.durationSec : 0;
  const phase = sstvTxPhase(t, p);
  sstvTxBarFill.style.width = `${pct.toFixed(1)}%`;
  sstvTxBar.setAttribute('aria-valuenow', String(Math.round(pct)));
  sstvTxProgressTime.textContent = `${mmss(t)} / ${mmss(p.durationSec)}`;
  const what = phase.line ? `Picture · line ${phase.line} of ${p.lines}` : phase.label;
  sstvTxProgressDetail.textContent = `${what} · ${mmss(p.durationSec - t)} left`;
  drawSstvTxReveal(p, phase.pictureFrac);
  if (!sstvCurrent) sstvStatusEl.textContent = `Sending ${p.name} · ${Math.round(pct)}%`;
}

function startSstvTxProgress({ name, durationSec, elapsedSec, startTime, timeline, lines, png }) {
  const elapsed = Number.isFinite(elapsedSec) ? elapsedSec : startTime ? Math.max(0, (Date.now() - startTime) / 1000) : 0;
  const p = { name, t0: Date.now() - elapsed * 1000, durationSec: durationSec || timeline?.totalSec || 0, timeline, lines: lines || 0, img: null, lastRow: -1 };
  sstvTxProgress = p;
  sstvSaveBtn.hidden = true; // it would save the last picture shown, not this one; back once ours is in the strip
  sstvTxBar.classList.remove('sstv-tx__bar--preparing');
  sstvTxProgressLabel.textContent = `Sending ${name}`;
  setSstvTxBarMarks(p);
  sstvTxProgressEl.hidden = false;
  if (png) {
    const img = new Image();
    img.onload = () => {
      if (sstvTxProgress !== p) return;
      p.img = img;
      sstvSize(img.width, img.height, 1);
      tickSstvTxProgress();
    };
    img.src = `data:image/png;base64,${png}`;
    p.png = png;
  }
  tickSstvTxProgress();
  sstvTxTimer = setInterval(tickSstvTxProgress, 250);
}

/** Ends the progress display; puts the picture that was on the SSTV screen back unless `keepScreen`. */
function stopSstvTxProgress({ keepScreen = false } = {}) {
  const had = sstvTxProgress;
  sstvTxProgress = null;
  clearInterval(sstvTxTimer);
  sstvTxTimer = null;
  sstvTxProgressEl.hidden = true;
  sstvTxProgressLabel.textContent = '';
  sstvTxProgressTime.textContent = '';
  sstvTxProgressDetail.textContent = '';
  sstvTxBar.classList.remove('sstv-tx__bar--preparing');
  sstvTxBarFill.style.width = '0%';
  setSstvTxBarMarks(null);
  if (!had || keepScreen || sstvCurrent) return;
  if (sstvShown) showSstvPicture(sstvShown);
  else {
    sstvCtx.fillStyle = '#000';
    sstvCtx.fillRect(0, 0, sstvCanvas.width, sstvCanvas.height);
    sstvStatusEl.textContent = 'listening for a picture…';
  }
}

document.getElementById('sstv-tx-progress-stop').addEventListener('click', () => {
  sstvTxProgressDetail.textContent = 'Stopping…';
  link.request('abortSstv').catch((err) => showError(`Couldn't stop the picture: ${err.message}`));
});

link.addEventListener('sstv-tx-status', (event) => {
  const detail = event.detail || {};
  const { status, name, durationSec, error } = detail;
  if (status !== 'encoding' && status !== 'sending' && status !== 'aborted') sstvCancelPending = false;
  sstvTxBusy = status === 'encoding' || status === 'sending';
  sstvTxSendBtn.classList.toggle('ptt--active', sstvTxBusy);
  if (sstvTxBusy) sstvTxSendBtn.textContent = 'Stop';
  else updateSstvTxSendLabel();
  switch (status) {
    case 'encoding':
      stopSstvTxProgress({ keepScreen: true });
      sstvTxProgressLabel.textContent = `Preparing ${name}…`;
      sstvTxProgressTime.textContent = durationSec ? mmss(durationSec) : '';
      sstvTxProgressDetail.textContent = 'Encoding the picture; the radio transmits once it is ready.';
      sstvTxBar.classList.add('sstv-tx__bar--preparing');
      sstvTxProgressEl.hidden = false;
      sstvTxStatus.textContent = '';
      break;
    case 'sending':
      clearInterval(sstvTxTimer);
      startSstvTxProgress(detail);
      sstvTxStatus.textContent = '';
      break;
    case 'sent':
      // The sent picture follows as an sstv-picture event and takes the screen.
      stopSstvTxProgress({ keepScreen: true });
      sstvTxStatus.textContent = `Sent ${name} (${mmss(durationSec)}).`;
      break;
    case 'aborted':
      stopSstvTxProgress();
      sstvTxStatus.textContent = 'Stopped.';
      if (sstvCancelPending) closeSstvTxEditor();
      sstvCancelPending = false;
      break;
    case 'error':
      stopSstvTxProgress();
      sstvTxStatus.textContent = `Couldn't send: ${error || 'unknown error'}`;
      break;
    default:
      break;
  }
});

link.addEventListener('sstv-fsk-id', (event) => {
  const { id, time, text } = event.detail || {};
  for (const t of sstvStripEl.children) if (Number(t.dataset.id) === id && Number(t.dataset.time) === time) t.title += ` · ${text}`;
  if (sstvShown && sstvShown.id === id && sstvShown.time === time) {
    sstvShown.fskId = text;
    if (!sstvCurrent) sstvStatusEl.textContent = sstvPictureLine(sstvShown);
  }
});

link.addEventListener('tty-tx-status', (event) => {
  const { status, mode, message, nframes, durationSec, error, note, freqHz, afsk } = event.detail || {};
  const wasAfsk = rttyAfskInFlight;
  rttyAfskInFlight = status === 'sending' && mode === 'RTTY' && afsk?.markRfHz != null;
  if (wasAfsk && !rttyAfskInFlight) {
    // Resynchronise with the radio after the AFSK detour.
    link.request('getMode').then((d) => updateModeButtons(d.value.mode)).catch(() => {});
    link.request('getFrequency').then((d) => updateFrequencyDisplay(d.value)).catch(() => {});
  }
  ttyTxInFlight = status === 'sending';
  ttySendBtn.textContent = ttyTxInFlight ? 'Stop' : 'Send';
  ttySendBtn.classList.toggle('ptt--active', ttyTxInFlight);
  ttyStatusEl.hidden = false;
  const shown = (message || '').replace(/\r/g, '').replace(/\n/g, ' ⏎ ');
  switch (status) {
    case 'sending': {
      const detail = [];
      if (nframes) detail.push(`${nframes} frame${nframes === 1 ? '' : 's'}`);
      if (durationSec) detail.push(`${durationSec.toFixed(1)} s`);
      if (mode === 'JTTY' && freqHz) detail.push(`${freqHz}–${Math.round(freqHz + 93.75)} Hz`);
      if (mode === 'OLIVIA' && freqHz) detail.push(`centre ${freqHz} Hz`);
      if (mode === 'HELL' && freqHz) detail.push(`tone ${freqHz} Hz`);
      if (mode === 'RTTY' && afsk) detail.push(`AFSK on ${afsk.sideband}-D, mark ${afsk.markHz} Hz / space ${afsk.spaceHz} Hz`);
      if (mode === 'OLIVIA') appendOliviaText(`${message || ''}\n`, { own: true });
      if (mode === 'HELL') appendRxText(hellRxTextEl, `${message || ''}\n`, { own: true });
      ttyStatusEl.textContent = `Sending ${TTY_CHIP_LABEL[mode] ?? mode}: "${shown}"${detail.length ? ` (${detail.join(', ')})` : ''}…${note ? ` ${note}.` : ''}`;
      break;
    }
    case 'sent':
      ttyStatusEl.textContent = `Sent ${TTY_CHIP_LABEL[mode] ?? mode}: "${shown}"`;
      break;
    case 'aborted':
      ttyStatusEl.textContent = `Stopped ${TTY_CHIP_LABEL[mode] ?? mode} transmission.`;
      break;
    case 'error':
      ttyStatusEl.textContent = `${TTY_CHIP_LABEL[mode] ?? (mode || 'TTY')} TX failed: ${error || 'unknown error'}`;
      break;
    default:
      ttyStatusEl.hidden = true;
  }
});

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
  updateTtyUi();
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
  // "DATA MODE" toggle (CI-V 1A 06) with its own MOD-Input source
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
  if (ft8Active) return;
  ft8Active = true;
  ft8ModeBtn.classList.add('chip--active');
  setCwPaddleVisible(false);
  setRttyTickerVisible(false);
  updateTtyUi();
  setFt8UiVisible(true);
  updateFt8VariantUi();
  if (!ft8ComposerInput.value) ft8ComposerInput.value = defaultCqMessage(stationCallsign, stationGrid);
  currentQsoFreqHz = ft8DefaultTxFreqHz;
  scopeDisplay.setQsoFreq(currentQsoFreqHz);
  ft8LastBandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
}

/**
 * Leaves FT8 mode — called when the operator picks any real hardware mode.
 * With `local`, another browser left it and has already told the server and
 * the radio, so only this page's display changes (see applyAppModes()).
 */
function exitFt8Mode({ local = false, keepDataMode = false } = {}) {
  if (!ft8Active) return;
  ft8Active = false;
  ft8ModeBtn.classList.remove('chip--active');
  updateTtyUi();
  // Reverts the chip's label back to the neutral "FT8/FT4" — see
  // updateFt8VariantUi()'s doc comment.
  updateFt8VariantUi();
  setFt8UiVisible(false);
  if (local) return;
  link.request('setFt8Active', { active: false }).catch((err) => showError(`Couldn't stop FT8 decoding: ${err.message}`));
  // Restore whatever MOD Input source the picked hardware mode expects
  // (typically the front-panel mic) — see enterFt8Mode()'s DATA MODE
  // comment for why this was turned on in the first place. Not when
  // going straight on to WSPR, which needs it on too.
  if (keepDataMode) return;
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

// --- Current conditions (the link beside the Band label) ---
// The server works the table out (server/band-conditions.js); this only shows it.
const conditionsBtn = document.getElementById('conditions-btn');
const conditionsDialog = document.getElementById('conditions-dialog');
const conditionsBody = document.getElementById('conditions-body');
const conditionsNote = document.getElementById('conditions-note');
const conditionsError = document.getElementById('conditions-error');

function conditionsCell(c, local) {
  const td = document.createElement('td');
  const tag = document.createElement('span');
  const key = c.tag === 'N/A' ? 'na' : c.tag.toLowerCase();
  tag.className = `conditions__tag conditions__tag--${key}`;
  tag.textContent = c.tag;
  td.appendChild(tag);
  if (c.tag !== 'N/A') {
    const detail = document.createElement('span');
    detail.className = 'conditions__detail';
    const who = local ? `${c.reporters} rx, ${c.stations} heard` : `${c.stations} heard`;
    detail.textContent = c.stations ? `${c.rangeKm.toLocaleString()} km · ${who}` : 'nothing heard';
    if (!local && c.lastMs) detail.title = `last listened at ${utcHhmm(c.lastMs)} UTC (${c.slots} slots)`;
    td.appendChild(detail);
  }
  return td;
}

function renderConditions(r) {
  conditionsBody.innerHTML = '';
  for (const b of r.bands) {
    const tr = document.createElement('tr');
    const band = document.createElement('td');
    band.className = 'conditions__band';
    band.textContent = b.band;
    tr.append(band, conditionsCell(b.myQth, false), conditionsCell(b.local, true));
    conditionsBody.appendChild(tr);
  }
  const notes = [];
  notes.push(`Range: how far most of the stations heard were. ${rangeTagsText(r.tags)}`);
  notes.push(`My QTH: WSPR spots decoded here, last ${r.myWindowMin} min. N/A: not listened on that band.`);
  const when = r.localUpdatedMs ? ` (updated ${utcHhmm(r.localUpdatedMs)} UTC)` : '';
  notes.push(`Local area: WSPR reporters in ${r.squares.length ? r.squares.join(' ') : 'the grid squares around here'}, last ${r.localWindowMin} min, from wsprnet.org spots via wspr.live${when}.`);
  conditionsNote.textContent = notes.join(' ');
  // why a column is all N/A, where it can't be missed
  const problems = [];
  if (r.myError) problems.push(r.myError);
  if (r.localError) problems.push(`Local area: ${r.localError}${r.localUpdatedMs ? ' (showing the last answer)' : ''}.`);
  conditionsError.textContent = problems.join(' ');
  conditionsError.hidden = problems.length === 0;
}

/** "Great ≥ 10,000 km, Good ≥ 5,000 km, ..., Dismal below." */
function rangeTagsText(tags) {
  return `${tags.map((t) => `${t.tag} ≥ ${t.km.toLocaleString()} km`).join(', ')}, Dismal below.`;
}

conditionsBtn.addEventListener('click', () => {
  conditionsBody.innerHTML = '';
  conditionsError.hidden = true;
  conditionsNote.textContent = 'Loading…';
  if (typeof conditionsDialog.showModal === 'function') conditionsDialog.showModal();
  else conditionsDialog.setAttribute('open', '');
  link
    .request('getBandConditions')
    .then((r) => renderConditions(r))
    .catch((err) => {
      conditionsNote.textContent = `Couldn't get the conditions: ${err.message}`;
    });
});
document.getElementById('conditions-close').addEventListener('click', () => conditionsDialog.close?.() ?? conditionsDialog.removeAttribute('open'));
// a tap outside the window closes it too
conditionsDialog.addEventListener('click', (e) => {
  if (e.target === conditionsDialog) conditionsDialog.close();
});

// --- WSPR (the third DIGI choice; see server/wspr-bridge.js) ---

/**
 * Puts the radio on USB + DATA MODE at the band's WSPR frequency and turns
 * WSPR on in the server. The server decodes every 2-minute slot, and
 * transmits about 1 slot in 5 once "Transmit" is ticked.
 */
function enterWsprMode() {
  wsprActive = true;
  ft8ModeBtn.classList.add('chip--active');
  setCwPaddleVisible(false);
  setRttyTickerVisible(false);
  updateTtyUi();
  setWsprUiVisible(true);
  updateFt8VariantUi();
  link
    .request('setMode', { mode: 'USB' })
    .then(() => updateModeButtons('USB'))
    .catch((err) => showError(`Couldn't set USB for WSPR: ${err.message}`));
  // after the mode: the mode command turns DATA MODE off
  link.request('setDataMode', { on: true }).catch((err) => showError(`Couldn't enable DATA MODE for WSPR: ${err.message}`));
  link
    .request('setWsprActive', { active: true })
    .then(() => syncTxPower())
    .catch((err) => showError(`Couldn't start WSPR: ${err.message}`));
  wsprLastBandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
  tuneWsprToBand(wsprLastBandName && WSPR_FREQUENCIES[wsprLastBandName] ? wsprLastBandName : '20m');
}

/** WSPR is already on in the server (another browser, or before a reconnect): show it, send nothing. */
function reflectWsprActiveFromServer() {
  if (wsprActive) return;
  wsprActive = true;
  ft8ModeBtn.classList.add('chip--active');
  setCwPaddleVisible(false);
  setRttyTickerVisible(false);
  updateTtyUi();
  setWsprUiVisible(true);
  updateFt8VariantUi();
  wsprLastBandName = currentFreqHz != null ? bandNameForFrequency(currentFreqHz) : null;
}

/**
 * Leaves WSPR. With `local`, another browser left it (only this page's
 * display changes). With `keepDataMode`, DATA MODE stays on for FT8.
 */
function exitWsprMode({ local = false, keepDataMode = false } = {}) {
  if (!wsprActive) return;
  wsprActive = false;
  ft8ModeBtn.classList.remove('chip--active');
  updateTtyUi();
  updateFt8VariantUi();
  setWsprUiVisible(false);
  if (local) return;
  // The server puts the power from before WSPR back.
  link
    .request('setWsprActive', { active: false })
    .then(() => syncTxPower())
    .catch((err) => showError(`Couldn't stop WSPR: ${err.message}`));
  if (!keepDataMode) link.request('setDataMode', { on: false }).catch((err) => showError(`Couldn't disable DATA MODE: ${err.message}`));
}

function setWsprUiVisible(active) {
  wsprPanelEl.hidden = !active;
  pttSectionEl.hidden = active || ft8Active;
  const filterControl = FUNCTION_CONTROLS.find((c) => c.key === 'filter');
  if (filterControl && filterControl.buttonEl) filterControl.buttonEl.hidden = active || ft8Active;
  rebuildTxPowerOptions();
  syncTxPower();
  updateTtyUi();
  if (active) renderWsprStatus(wsprStatus);
}

function tuneWsprToBand(bandName) {
  const hz = WSPR_FREQUENCIES[bandName];
  if (hz == null) return;
  wsprLastBandName = bandName;
  link
    .request('setFrequency', { value: hz })
    .then(() => updateFrequencyDisplay(hz))
    .catch((err) => showError(`Couldn't tune to the ${bandName} WSPR frequency: ${err.message}`));
}

/** A new band (typed in, or from the radio): go to its WSPR frequency. */
function checkWsprBandChange(hz) {
  const bandName = bandNameForFrequency(hz);
  if (bandName && bandName !== wsprLastBandName && WSPR_FREQUENCIES[bandName] != null) tuneWsprToBand(bandName);
  else if (bandName) wsprLastBandName = bandName;
}

function setWsprTxHz(hz) {
  const txHz = Math.round(Math.max(WSPR_TX_HZ_RANGE[0], Math.min(WSPR_TX_HZ_RANGE[1], hz)));
  scopeDisplay.setQsoFreq(txHz);
  link
    .request('setWsprTx', { txHz })
    .then((r) => renderWsprStatus(r.wspr))
    .catch((err) => showError(`Couldn't set the WSPR frequency: ${err.message}`));
}

const utcHhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** Shows the server's WSPR state (EVENT.WSPR_STATUS). */
function renderWsprStatus(s) {
  if (!s) return;
  wsprStatus = s;
  wsprTxEnabledEl.checked = !!s.txEnabled;
  wsprTxEnabledEl.disabled = !s.canTransmit;
  wsprTxEnabledEl.parentElement.title = s.canTransmit ? 'Transmit in about 1 slot in 5, picked at random' : s.txReason || '';
  if (document.activeElement !== wsprTxHzEl) wsprTxHzEl.value = String(s.txHz);
  wsprTxHzEl.disabled = !s.canTransmit;
  wsprTxMsgEl.textContent = s.canTransmit ? s.txMessage : s.txReason || '';
  if (wsprActive) scopeDisplay.setQsoFreq(s.txHz);
  let slot = '—';
  if (s.phase === 'tx' && s.slotEndMs) slot = `transmitting ${utcHhmm(s.slotStartMs)}`;
  else if (s.phase === 'rx' && s.slotStartMs != null) slot = `receiving ${utcHhmm(s.slotStartMs)}–${utcHhmm(s.slotEndMs)}`;
  if (s.decoding) slot += ' · decoding';
  wsprSlotEl.textContent = slot;
  const lines = [];
  if (s.txEnabled) lines.push(s.nextTx ? `Transmits next at ${utcHhmm(s.nextTx)} UTC.` : 'Transmit is on (about 1 slot in 5).');
  if (s.lastSlotStartMs != null) lines.push(`${s.lastDecodeCount} heard at ${utcHhmm(s.lastSlotStartMs)}.`);
  if (!s.upload) lines.push('Not uploading to wsprnet.org.');
  else if (s.uploadStatus) {
    const u = s.uploadStatus;
    lines.push(u.ok ? `Sent to wsprnet.org (${utcHhmm(u.slotStartMs)}).` : `wsprnet.org upload failed: ${u.error}`);
  }
  wsprStatusEl.textContent = lines.join(' ');
  wsprStatusEl.hidden = lines.length === 0;
}

function wsprRow(d) {
  const row = document.createElement('div');
  row.className = 'ft8-table__row';
  row.setAttribute('role', 'row');
  const call = d.callsign || d.message.split(' ')[0];
  const cells = [utcHhmm(d.slotStartMs), String(d.snr), d.dt.toFixed(1), ((d.dialHz + d.audioHz) / 1e6).toFixed(6), call, d.grid || '', String(d.dbm)];
  for (const text of cells) {
    const cell = document.createElement('span');
    cell.setAttribute('role', 'cell');
    cell.textContent = text;
    row.appendChild(cell);
  }
  row.title = `${d.message} · drift ${d.drift} Hz · ${Math.round(d.audioHz)} Hz audio`;
  return row;
}

/** EVENT.WSPR_DECODES: newest slot at the top. */
function addWsprDecodes({ decodes, replace, slotStartMs, dialHz }) {
  if (replace) wsprTableBodyEl.innerHTML = '';
  for (const old of wsprTableBodyEl.querySelectorAll('.wspr-table__row--new')) old.classList.remove('wspr-table__row--new');
  const list = (decodes || []).map((d) => ({ slotStartMs, dialHz, ...d }));
  // newest slot first, strongest first within a slot
  list.sort((a, b) => b.slotStartMs - a.slotStartMs || b.snr - a.snr);
  const frag = document.createDocumentFragment();
  for (const d of list) {
    const row = wsprRow(d);
    if (!replace) row.classList.add('wspr-table__row--new');
    frag.appendChild(row);
  }
  wsprTableBodyEl.prepend(frag);
  while (wsprTableBodyEl.children.length > WSPR_MAX_ROWS) wsprTableBodyEl.lastElementChild.remove();
}

link.addEventListener('wspr-status', (event) => renderWsprStatus(event.detail));
link.addEventListener('wspr-decodes', (event) => addWsprDecodes(event.detail));
wsprTxEnabledEl.addEventListener('change', () => {
  link
    .request('setWsprTx', { enabled: wsprTxEnabledEl.checked })
    .then((r) => renderWsprStatus(r.wspr))
    .catch((err) => showError(`Couldn't change WSPR transmit: ${err.message}`));
});
wsprTxHzEl.addEventListener('change', () => {
  const hz = Number(wsprTxHzEl.value);
  if (Number.isFinite(hz)) setWsprTxHz(hz);
});

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
  setRttyTickerVisible(false);
  updateTtyUi();
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
  if (freeDvActive) return;
  freeDvActive = true;
  freeDvModeBtn.classList.add('chip--active');
  freeDvSpotLabel.hidden = false;
  freeDvReportSectionEl.hidden = false;
  updateFreeDvVariantUi();
  setRttyTickerVisible(false);
  updateTtyUi();
}

/** Leaves FreeDV mode — called when the operator picks any real hardware mode, or FT8 (with `local`: see exitFt8Mode()). */
function exitFreeDvMode({ local = false } = {}) {
  if (!freeDvActive) return;
  freeDvActive = false;
  freeDvModeBtn.classList.remove('chip--active');
  updateTtyUi();
  freeDvSpotLabel.hidden = true;
  freeDvReportSectionEl.hidden = true;
  // Reverts the chip's label back to the neutral "FreeDV" — see
  // updateFreeDvVariantUi()'s doc comment.
  updateFreeDvVariantUi();
  if (local) return;
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
    callAlert.reset();
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

  // Someone calling us: a chime (once per caller; see call-alert.js), and their rows marked.
  const callers = callAlert.check(sorted, slotStartMs, stationCallsign);
  if (callers.length) playCallChime();

  for (const msg of sorted) {
    const row = document.createElement('div');
    row.className = 'ft8-table__row';
    if (isRelatedToQso(msg, activeQso)) row.classList.add('ft8-table__row--qso');
    if (isToMe(msg)) row.classList.add('ft8-table__row--to-me');
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
  cwComposerEl.hidden = !visible;
  if (visible && !cwTextInput.value && stationCallsign) cwTextInput.value = `CQ CQ DE ${stationCallsign} ${stationCallsign} K`;
  pttHintEl.textContent = visible
    ? "Type text and press Send (or Enter): the radio's own keyer sends it at the WPM set below. Or hold Dot/Dash to key by hand (iambic — hold both to alternate; CI-V round-trip latency makes that timing less precise than a hardware keyer)."
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
// Not shown for now (RNNOISE_IN_UI); the button and the server's RNNoise
// support are kept, so setting this to true brings it back.
const RNNOISE_IN_UI = false;

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
if (RNNOISE_IN_UI) {
  if (nrControl && nrControl.buttonEl) {
    nrControl.buttonEl.insertAdjacentElement('afterend', rnnoiseButton);
  } else {
    functionControlsEl.appendChild(rnnoiseButton);
  }
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

// Beneath the RNN button, per the request this implements (in its place, after NR, while RNN is hidden).
if (RNNOISE_IN_UI) rnnoiseButton.insertAdjacentElement('afterend', hamnoiseButton);
else if (nrControl && nrControl.buttonEl) nrControl.buttonEl.insertAdjacentElement('afterend', hamnoiseButton);
else functionControlsEl.appendChild(hamnoiseButton);

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

// --- Audio format: full or compressed ---
// Each browser chooses for itself (see server/audio-bridge.js). Full is raw
// PCM, 768 kbit/s each way at 48 kHz: fine on a LAN. Compressed is Opus
// (WebCodecs) at about 24 kbit/s, or 12 kHz ADPCM at 48 kbit/s where the
// browser can't do Opus. RX and TX are chosen separately: some browsers
// decode Opus but can't encode it. The default is full when the page was
// opened by a LAN address or name, compressed otherwise (e.g. through a
// VPN or port forward). A choice made with the button is remembered on
// this device only.
const AUDIO_FORMAT_KEY = 'piro.audioFormat';
let serverAudioCodecs = ['pcm'];
let serverOpusBitrate = 24000;
let opusCaps = null;

function loadAudioFormat() {
  try {
    const v = localStorage.getItem(AUDIO_FORMAT_KEY);
    if (v === 'full' || v === 'compressed') return v;
  } catch {
    // storage blocked: use the default
  }
  return isLanHost(location.hostname) ? 'full' : 'compressed';
}
let audioFormat = loadAudioFormat();

const CODEC_NAMES = { pcm: 'raw PCM', opus: 'Opus', adpcm: 'ADPCM' };
function codecRate(codec) {
  if (codec === 'opus') return `about ${Math.round(serverOpusBitrate / 1000)} kbit/s`;
  if (codec === 'adpcm') return '48 kbit/s';
  return `${Math.round((audioPipeline?.sampleRate || 48000) * 16 / 1000)} kbit/s`;
}

function renderAudioFormat() {
  if (!audioPipeline) return;
  const { rxCodec: rx, txCodec: tx } = audioPipeline;
  const canCompress = serverAudioCodecs.length > 1;
  audioFormatBtn.disabled = !canCompress && audioFormat === 'full';
  audioFormatBtn.textContent = rx === 'pcm' ? 'Audio: full' : `Audio: ${CODEC_NAMES[rx]}`;
  audioFormatBtn.classList.toggle('chip--active', rx !== 'pcm');
  const each = rx === tx ? `${CODEC_NAMES[rx]}, ${codecRate(rx)} each way` : `receive ${CODEC_NAMES[rx]} (${codecRate(rx)}), transmit ${CODEC_NAMES[tx]} (${codecRate(tx)})`;
  audioFormatBtn.title = canCompress
    ? `${each}. Tap for ${audioFormat === 'full' ? 'compressed audio (for use away from home)' : 'full audio (for the home network)'}.`
    : `${each}. This server can't compress audio (it needs mono audio).`;
}

/** Asks the server for this browser's RX format and sets the pipeline to match. */
async function setAudioCodecs(rx, tx) {
  if (!audioPipeline) return;
  try {
    await link.request('setAudioCodec', { codec: rx });
  } catch (err) {
    showError(`Couldn't change the audio format: ${err.message}`);
    rx = 'pcm';
    tx = 'pcm';
  }
  audioPipeline.setCodecs(rx, tx);
  renderAudioFormat();
}

async function applyAudioFormat() {
  if (!audioPipeline) return;
  let rx = 'pcm';
  let tx = 'pcm';
  if (audioFormat === 'compressed' && serverAudioCodecs.length > 1) {
    opusCaps ??= await opusSupport();
    const opus = serverAudioCodecs.includes('opus');
    rx = opus && opusCaps.rx ? 'opus' : 'adpcm';
    tx = opus && opusCaps.tx ? 'opus' : 'adpcm';
  }
  await setAudioCodecs(rx, tx);
}

audioFormatBtn.addEventListener('click', () => {
  audioFormat = audioFormat === 'full' ? 'compressed' : 'full';
  try {
    localStorage.setItem(AUDIO_FORMAT_KEY, audioFormat);
  } catch {
    // storage blocked: the choice lasts until the page is reloaded
  }
  applyAudioFormat();
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
/** Fills the power menu: 1-5 W in WSPR, the usual steps otherwise. */
function rebuildTxPowerOptions() {
  const options = wsprActive ? WSPR_POWER_OPTIONS : TX_POWER_OPTIONS;
  if (options === txPowerOptions && txPowerSelect.options.length) return;
  txPowerOptions = options;
  txPowerSelect.innerHTML = '';
  options.forEach((option, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = option.label;
    txPowerSelect.appendChild(opt);
  });
  txPowerSelect.selectedIndex = -1; // until the radio says
}
rebuildTxPowerOptions();
txPowerSelect.addEventListener('change', () => {
  const option = txPowerOptions[txPowerSelect.selectedIndex];
  if (!option) return;
  link
    .request('setTxPower', { watts: option.watts })
    .then(() => syncTxPower())
    .catch((err) => showError(`Couldn't set TX power: ${err.message}`));
});

async function syncTxPower() {
  if (document.activeElement === txPowerSelect) return;
  try {
    const data = await link.request('getTxPower');
    // Shows nothing selected if the radio is at a power the menu doesn't list.
    txPowerSelect.selectedIndex = txPowerOptions.findIndex((option) => option.watts === data.watts);
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

// --- CW text ---
// Typed text sent as CW by the radio's own keyer (server/cw-tx-bridge.js),
// at the speed in the WPM box. The radio does the timing, so unlike the
// DOT/DASH paddle it isn't affected by the CI-V round trip. Send becomes
// Stop while it is going out; every browser shows the progress.
let cwTxBusy = false;
let cwTxTimer = null;

function sendCwText() {
  if (cwTxBusy) {
    link.request('abortCw').catch((err) => showError(`Couldn't stop the CW: ${err.message}`));
    return;
  }
  const text = cwTextInput.value.trim();
  if (!text) return;
  const wpm = Math.max(6, Math.min(48, Math.round(Number(cwWpmInput.value) || 20)));
  link.request('sendCw', { text, wpm }).catch((err) => showError(`Couldn't send: ${err.message}`));
}
cwSendBtn.addEventListener('click', sendCwText);
cwTextInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  if (!cwTxBusy) sendCwText();
});

link.addEventListener('cw-tx-status', (event) => {
  const { status, text, wpm, durationSec, dropped, error } = event.detail || {};
  clearInterval(cwTxTimer);
  cwTxBusy = status === 'sending';
  cwSendBtn.textContent = cwTxBusy ? 'Stop' : 'Send';
  cwSendBtn.classList.toggle('ptt--active', cwTxBusy);
  cwStatusEl.hidden = false;
  const left = dropped?.length ? ` (left out: ${dropped.join(' ')})` : '';
  switch (status) {
    case 'sending': {
      const t0 = Date.now();
      const tick = () => {
        const el = Math.min(durationSec, (Date.now() - t0) / 1000);
        cwStatusEl.textContent = `Sending CW at ${wpm} WPM: "${text}"${left} · ${mmss(el)} of ${mmss(durationSec)}`;
      };
      tick();
      cwTxTimer = setInterval(tick, 500);
      break;
    }
    case 'sent':
      cwStatusEl.textContent = `Sent CW at ${wpm} WPM: "${text}"${left}`;
      break;
    case 'aborted':
      cwStatusEl.textContent = 'Stopped.';
      break;
    case 'error':
      cwStatusEl.textContent = `Couldn't send: ${error || 'unknown error'}`;
      break;
    default:
      cwStatusEl.hidden = true;
  }
});

// --- Notes ---
// Short messages operators leave each other ("VK3ABC: on 40 m until 16:30"),
// kept on the Pi and shown in every browser: the three most recent, newest
// first, each with its time (this device's clock). When someone else adds
// one, this browser chimes and the screen flashes (or, if the device is set
// to reduce motion, just the notes light up). Nothing happens on connecting.
// The Pi clears them after an hour with no new note, or a couple of minutes
// after the last browser leaves. See REQUEST.POST_NOTE.
const notesEl = document.getElementById('notes');
const notesListEl = document.getElementById('notes-list');
const notesForm = document.getElementById('notes-form');
const notesInput = document.getElementById('notes-input');
const notesSendBtn = document.getElementById('notes-send');
const screenFlashEl = document.getElementById('screen-flash');

function renderNotes(notes) {
  notesListEl.replaceChildren(
    ...[...(notes || [])].reverse().map((n) => {
      const li = document.createElement('li');
      li.className = 'notes__item';
      const t = document.createElement('time');
      t.className = 'notes__time';
      const d = new Date(n.time);
      t.dateTime = d.toISOString();
      t.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const text = document.createElement('span');
      text.textContent = n.text;
      li.append(t, text);
      return li;
    })
  );
}

// The chime is made with Web Audio. Browsers only allow sound after the page
// has been touched, so the audio context is created on the first tap or key.
let chimeCtx = null;
function unlockChime() {
  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (chimeCtx.state === 'suspended') chimeCtx.resume().catch(() => {});
  } catch {
    chimeCtx = null;
  }
}
window.addEventListener('pointerdown', unlockChime, { capture: true });
window.addEventListener('keydown', unlockChime, { capture: true });

/** Two soft rising notes, about half a second in all. */
function playChime() {
  notesEl.dataset.chimes = String(Number(notesEl.dataset.chimes || 0) + 1);
  playTones([
    [880, 0],
    [1318.5, 0.16],
  ]);
}

/** An FT8/FT4 station calling us: three quick notes, so it isn't mistaken for a note. */
function playCallChime() {
  ft8PanelEl.dataset.callChimes = String(Number(ft8PanelEl.dataset.callChimes || 0) + 1);
  playTones([
    [1046.5, 0],
    [1318.5, 0.11],
    [1568, 0.22],
  ]);
}

function playTones(notes) {
  if (!chimeCtx || chimeCtx.state !== 'running') return;
  const t0 = chimeCtx.currentTime + 0.01;
  notes.forEach(([hz, at]) => {
    const osc = chimeCtx.createOscillator();
    const gain = chimeCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.45);
    osc.connect(gain).connect(chimeCtx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.5);
  });
}

/** One flash of the whole screen, dark to light and back (just the notes, with reduced motion). */
function flashScreen() {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const el = reduce ? notesEl : screenFlashEl;
  const cls = reduce ? 'notes--flash' : 'screen-flash--on';
  el.classList.remove(cls);
  void el.offsetWidth; // restart the animation if one is still running
  el.classList.add(cls);
  screenFlashEl.dataset.flashes = String(Number(screenFlashEl.dataset.flashes || 0) + 1);
}
screenFlashEl.addEventListener('animationend', () => screenFlashEl.classList.remove('screen-flash--on'));
notesEl.addEventListener('animationend', () => notesEl.classList.remove('notes--flash'));

link.addEventListener('notes', (event) => {
  const { notes, posted } = event.detail || {};
  renderNotes(notes);
  if (posted) {
    playChime();
    flashScreen();
  }
});

notesForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = notesInput.value.trim();
  if (!text) return;
  notesSendBtn.disabled = true;
  link
    .request('postNote', { text })
    .then(({ notes }) => {
      renderNotes(notes);
      // clear what was sent, not something typed since
      if (notesInput.value.trim() === text) notesInput.value = '';
    })
    .catch((err) => showError(`Couldn't send the note: ${err.message}`))
    .finally(() => {
      notesSendBtn.disabled = false;
    });
});

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
  // Not in RTTY/JTTY, where the PTT button is replaced by text entry + Send
  // and nothing should be able to key the microphone.
  if (event.code === 'Space' && !isTextEntryFocused() && !event.repeat && !ttyMode()) {
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
