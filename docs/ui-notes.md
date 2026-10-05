# UI notes

Working notes for `src/client/` beyond the app shell (see `pwa-notes.md`
for the HTTPS/service-worker constraint, which still applies).

## Architecture

Plain ES modules, no build step, no framework — consistent with the
project's "no additional components" goal and simple enough that a build
step would add more friction than value at this size.

- `rpc.js` — `RigLink`: owns the WebSocket connection, request/response
  correlation (by `id`), reconnection with a fixed 2s backoff, dispatches
  unsolicited JSON server events (`frequency`, `mode`, `ptt`, `rig-error`,
  `audio-error`, `scope-error`, `connected`) as DOM `CustomEvent`s, and
  decodes tagged binary frames into `audio-frame`/`scope-line` events —
  see "Binary frame tagging" below.
- `audio.js` — `AudioPipeline`: the Web Audio graph for both directions.
  See "Audio wire format" below.
- `scope.js` — `ScopeDisplay`: renders spectrum scope lines onto a live
  trace canvas and a scrolling waterfall canvas, plus a dashed green
  vertical marker on the trace tracking the currently tuned frequency
  (`setTunedFrequency()`, called from `app.js`'s `updateFrequencyDisplay`
  — the single choke point every frequency update already flows through,
  whether from the initial snapshot, an unsolicited radio event, a band
  click, or direct entry). Not drawn on the waterfall: each row is a
  snapshot from a different moment, so a static column wouldn't
  correctly represent where the radio was tuned at every past row — see
  wfview's convention of only marking the live trace, which this follows.
  Both canvases are click-to-tune (RF scope only — disabled while
  `pushAudioSpectrum()`'s FT8 audio-domain view is showing, see its own
  doc comment): a click's x position is converted back to a frequency
  via a single shared helper (`freqForEvent()`, a closure in the
  constructor) built from `frequencyAtFraction()` (the exact inverse of
  `tuningMarkerX()`, using the range from the most recently received
  line — the two are round-trip tested together in
  `test/scope-display.test.mjs`) — the *same* helper backs both the
  click handler and the hover tooltip below, so they can never disagree
  with each other about what frequency a given pixel means. The result
  is snapped to the nearest kHz (`snapToNearestKHz()`, e.g. a click near
  7.100340 MHz selects exactly 7,100,000 Hz) before being handed to
  `onFrequencyClick`, which `app.js` wires to a `setFrequency` request —
  the frequency actually requested is always exactly the (kHz-snapped)
  frequency under the pointer, never a blend with whatever the radio was
  previously tuned to. **Exception: while in RTTY mode** (`setRttyMode()`,
  driven from the same `setRttyTickerVisible()` call as the offset marker
  below) **or CW mode** (`setCwMode()`, driven from `setCwPaddleVisible()`
  the same way), the kHz snap is skipped entirely — the exact clicked
  frequency is used instead (only `Math.round()`'d to the nearest whole
  Hz, since CI-V requires an integer). Both signals are far narrower than
  a voice signal — RTTY's mark/space tones are only 170Hz apart, and a CW
  signal's own bandwidth is narrower still — so a 1kHz snap could land
  the tuned frequency further from the intended signal than the signal
  itself is wide, unlike voice where a "clean" kHz dial reading is what
  operators actually want. `_cwMode`/`_rttyMode` are checked together
  (`this._rttyMode || this._cwMode`) in both the click handler and the
  hover preview, since the two modes want identical tuning precision —
  only RTTY additionally gets its own offset marker (below).

  Hovering (RF scope only, same audio-mode gating as the click handler)
  shows a small tooltip that tracks the pointer (`position: fixed`,
  `pointer-events: none`, styled via `.scope__hover-tip` in
  `styles.css`) previewing that same frequency a click would select — e.g.
  "7.100 MHz" (kHz-snapped) or, in RTTY mode, "7.100170 MHz" (exact, shown
  with enough decimal places to display the precise Hz value — see
  `_showHoverTip()`'s `precise` parameter) — so an operator can see
  exactly what a click at that position would select before committing to
  it. `mousemove`/`mouseleave` listeners on both canvases drive
  `_showHoverTip()`/`_hideHoverTip()`; the tooltip element lives outside
  both canvases (appended to `document.body`) specifically so
  `.scope__canvases`' `overflow: hidden` can't clip it near the panel's
  edges.

  **RTTY offset marker**: while in RTTY mode (`setRttyMode()`), the trace
  canvas gets a second dashed vertical line (`_drawRttyOffsetMarker()`),
  drawn the same way as the tuning marker itself — `RTTY_SHIFT_HZ` (170Hz,
  the standard amateur mark/space shift) below the tuned frequency, in
  blue (`#4fc3f7`) so it's never visually confused with the tuning
  marker's green or the FT8/QSO marker's amber. Per explicit request, this
  is trace-only, nothing is drawn into the waterfall: the same reasoning
  that keeps the tuning marker itself off the waterfall applies here too
  (each waterfall row is a snapshot from a different moment, so a static
  column there can't correctly represent every past row's tuned
  frequency).

  Also draws faint gridlines at each 50kHz
  division (`scopeDivisions()`, default step 50kHz, configurable via
  `divisionStepHz`) behind the trace curve; the matching tick *labels*
  are rendered as real DOM text in the `#scope-axis` strip below the
  canvases (`app.js`'s `renderScopeAxis()`), not as canvas text — small
  canvas text doesn't render as crisply, and percentage-based CSS
  positioning naturally tracks the container's rendered width without
  duplicating the DPR-aware pixel math already done for the canvas.
  Plain Canvas 2D, no charting library. The pure logic
  (`amplitudeToColor`, `tuningMarkerX`, `frequencyAtFraction`,
  `scopeDivisions`, `snapToNearestKHz`) is unit-tested directly in Node
  (`test/scope-display.test.mjs`, including a round-trip check that
  clicking exactly on the tuning marker recovers the same frequency); the
  actual canvas-drawing and click/hover-event wiring are not (need a
  real browser — see "Testing boundary" below).
- `smeter.js` — pure S-meter bucket logic (`sMeterLevelIndex`,
  `sMeterLabel`), unit-tested directly in Node
  (`test/smeter.test.mjs`). See "S-meter" below for why this is an
  approximation, not a calibrated reading.
- `mic-capture-processor.js` — an `AudioWorkletProcessor`, loaded via
  `audioContext.audioWorklet.addModule()` rather than a normal `<script>`
  tag; batches mic samples into ~20ms frames before handing them to the
  main thread.
- `app.js` — wires DOM elements to
  `RigLink`/`AudioPipeline`/`ScopeDisplay`/`smeter.js`. No other module
  imports it; it's the entry point loaded via `<script
  type="module">`.

## Binary frame tagging

Once scope data joined audio on the same binary WebSocket channel, frames
needed a way to say what they are. Every binary frame now starts with a
1-byte type tag (`BINARY_TYPE` — `AUDIO`=0x01, `SCOPE_LINE`=0x02, defined
identically in both `src/server/protocol.js` and duplicated as a constant
in `rpc.js`, since client and server don't share a module graph). `rpc.js`
strips/decodes this before dispatching `audio-frame`/`scope-line` events;
outgoing mic audio goes through `RigLink.sendAudioFrame()`, which adds the
tag rather than the caller having to remember to.

The scope-line binary format itself (fixed 12-byte header: mode,
main/sub, two little-endian UInt32 frequency fields, one flag byte, then
raw sample bytes) is documented in full in
`src/server/scope-bridge.js`'s doc comment — `rpc.js`'s `decodeScopeLine`
mirrors it exactly; keep both in sync if it ever changes.

## Audio wire format: PCM, not Opus

The server's audio bridge (phase 3) was originally built around Opus
encoding. For the browser client, the wire format was changed to **raw
16-bit PCM** with no codec at all — see the reasoning captured in
`src/server/audio-bridge.js`'s doc comment and `audio-notes.md`. Short
version: this is LAN-only, so compression doesn't earn its complexity,
and raw PCM works via plain Web Audio API in every browser without
WebCodecs (patchy Safari support) or a bundled WASM encoder. Opus is
still available server-side via `AUDIO_CODEC=opus` for a possible future
bandwidth-constrained scenario, but the shipped client doesn't use it.

**Consequence**: `AUDIO_SAMPLE_RATE`/`AUDIO_CHANNELS` on the server and
the client's audio graph must agree — the client reads these from the
`connected` event's `data.audio` (server-authoritative, not hardcoded
client-side), so changing the env vars doesn't require a client change.

## Sample rate honoring

`AudioPipeline` creates its `AudioContext` with an explicit `sampleRate`
matching the server's configured rate. Most modern browsers honor this,
but it's a request, not a guarantee — some mobile devices/OSes lock audio
hardware to a native rate regardless. Effects if a browser doesn't honor
it:

- **RX playback is unaffected** — `AudioBuffer`s are created with an
  explicit sample rate independent of the context's actual rate, and the
  browser resamples automatically on playback.
- **TX (mic) audio could be mildly pitch/speed-shifted** if the actual
  capture rate differs from what the server expects, since raw PCM
  carries no embedded rate — there's no resampling on the send path. Not
  a crash, just degraded audio quality on affected devices. Not currently
  detected or corrected; would need an explicit resampler (e.g. a
  polyphase resampler in the worklet) if this turns out to matter in
  practice.

## S-meter

Displayed as a segmented bargraph (S0 through S9 individually, then
+10dB through +60dB over S9 — 16 buckets), not a needle/dial (removed)
or a plain proportional bar (earlier designs).

**The bucket thresholds are real calibration data, not an approximation
this project derived**, and have been refined twice now as better data
became available:

1. Originally, evenly-spaced thresholds across the raw 0-255 range —
   there was no manufacturer table to draw from at the time, and Icom's
   S-meter is genuinely well-documented as non-linear/inconsistent
   across models and firmware, so presenting invented breakpoints as if
   calibrated would have been false precision.
2. A specific reference table (raw value range -> target S-meter
   reading) was then supplied directly, replacing the even spacing. That
   table could only distinguish "S1 - S3" as one combined range rather
   than three individual ones, and was shown that way (one bucket, one
   label) rather than inventing finer boundaries it didn't support.
3. **Current version**: a refined table, power-curve-derived, giving
   individual S1 through S9 buckets — supersedes the combined "S1-S3"
   range entirely. `S_METER_LEVELS` in `smeter.js` uses this table's
   exact thresholds. One data-quality note worth preserving: the
   source table's S0 row read "0-10" and S1's read "10-19" —
   technically overlapping at the value 10 — but since this bucket
   system only ever needs each level's *lower* bound (it finds the
   highest threshold a value meets or exceeds), S1's unambiguous start
   (10) is all that's needed to fully determine where S0 ends; no
   judgment call about the overlap was actually required, and none was
   made.

The UI shows just the bucketed label (e.g. "S7") — an earlier version
also appended the raw value alongside it (e.g. "S7 (raw 95)"), on the
reasoning that even genuine calibration data is
model/firmware/preamp-setting-dependent and this project has no way to
confirm it matches every reader's exact radio, but that raw suffix was
dropped per explicit request (see the matching change to the VSWR-mode
text below — `updateMeter()`'s own doc comment covers both).
`test/smeter.test.mjs` exhaustively checks all 256 possible raw values
against the source table directly, not just a handful of sample points,
so the bucket boundaries themselves stay covered regardless of what the
UI displays.

**While transmitting, the same 16-segment bar switches to showing VSWR
instead.** `startMeterPolling()` checks the existing `pttActive` flag on
every 500ms tick and requests `getSWR`/renders via `updateMeterAsVswr()`
instead of `getSMeter`/`updateMeter()` — so the switch happens on the
very next poll tick after PTT toggles (at most 500ms), not instantly, but
that's the same cadence the S-meter itself already updates at, so it
doesn't read as sluggish. VSWR uses its own independent set of CSS
classes (`.meter__segment--vswr-green/orange/red`) rather than reusing
the S-meter's `--active`/`--over` — a real constraint, not just tidiness:
6 of the 16 segments carry `--over` *permanently*, based on their fixed
S-unit bucket identity (assigned once at creation, in the loop building
`meterSegmentEls`), so toggling it dynamically per VSWR-zone would have
corrupted that structural assignment the next time S-meter mode rendered.
Switching back to S-meter mode explicitly clears all three VSWR classes
in `updateMeter()`, so nothing lingers from a previous transmit. The
segment *count* lit is a simple proportional fill between VSWR 1.0 (0
segments) and 5.0 (all 16) — see `src/client/vswr.js` and
`docs/civ-notes.md` for the raw-to-VSWR conversion itself, which (unlike
S-meter's bucket table) is a reasoned extension from Icom's documented
examples, not independently confirmed against a real transmit into a
known load.

The text readout (`#meter-value`) shows just `VSWR 1.5`-style — the raw
underlying meter reading it's computed from (`updateMeterAsVswr(raw)`'s
own parameter) used to also be appended in parentheses (`VSWR 1.5 (raw
84)`) but was dropped per explicit request, since it's implementation
detail an operator has no use for; `raw` is still passed into and used by
`rawToVswr()`/the segment-count math, just no longer surfaced in the
label text itself.

## Frequency display grouping

The read-only frequency display (`#freq-display`) shows an extra `.`
after the kilohertz group, per explicit request — `14.195.000` instead
of `formatMHz()`'s plain `14.195000` — so the kHz digits stand out from
the single-hertz ones at a glance, the same reason a phone number or a
large integer gets thousands separators. `formatMHzGrouped()` (`app.js`)
does this by splitting `formatMHz()`'s six-digit fractional part into a
3-and-3 pair and rejoining with an extra `.`; it's used **only** for this
one non-editable text node.

**The editable `<input>` deliberately does not get this treatment.**
`beginFreqEdit()`/`commitFreqEdit()` still populate/parse the plain
`formatMHz()` output (`14.195000`, matching the input's own
`placeholder="14.195000"` in `index.html`) — inserting a second `.` would
make the field's own value unparseable as a number the instant editing
starts: `parseFloat("14.195.000")` stops at the first `.` and silently
returns `14.195`, quietly dropping the kHz digits rather than throwing,
which would have been a real (if narrow) way to lose precision on commit.
So the grouped format is purely a display convenience for the read-only
state; typing a frequency in still works with an ordinary decimal.

## Frequency step buttons, band/mode layout, and RX function controls

The frequency display is flanked by four step buttons (`\u221210 kHz`,
`\u22121 kHz`, `+1 kHz`, `+10 kHz`, `FREQ_STEPS` in `app.js`) that adjust
the current frequency by the given delta and re-request it via
`setFrequency` — same request the band buttons and direct entry already
use. They're disabled until a frequency is actually known (guarded by
`currentFreqHz == null` in `stepFrequency()`, and disabled by default in
the markup, enabled alongside PTT in the `'connected'` handler) since
there's nothing to step from before that.

Band and mode chips use CSS Grid (`.chips--grid-5`, `.chips--grid-4`)
rather than the flex-wrap layout used elsewhere for chip rows —
deterministic N-per-row regardless of container width, matching the
2-rows-of-5 (10 bands, having dropped 2m/70cm) and 2-rows-of-4 (8 mode
chips: LSB/USB/AM/FM, then CW/RTTY/FT8/FreeDV — see `MODE_CHIPS` in
`app.js`) layout asked for, rather than a reflow that could vary by
viewport width.

To their right, five single-button toggles (`FUNCTION_CONTROLS` in
`app.js`) cover Preamp (Off/1/2), NR, NB, Notch (each Off/On), and
Filter (1/2/3, listed last so it renders directly under Notch) — see
`docs/civ-notes.md` for the underlying CI-V commands, including the
judgment call on Notch mapping to auto notch rather than manual notch,
and why Filter has no standalone CI-V command of its own (it's the
second byte of the existing mode-set command). Each button's text always
reads `"<control label> <state>"` (e.g. "P.Amp Off", "P.Amp 1", "NR On",
"Filter 2") and clicking cycles to the next state in `control.options`,
wrapping back to the first after the last.

**Kept genuinely in sync with the radio, not just with this UI's own
clicks.** These settings (plus the tuner on/off state, below) aren't
part of the radio's unsolicited "transceive" broadcasts the way
frequency/mode are — a front-panel change to any of them wouldn't be
pushed back to connected clients on its own. An earlier version had each
control optimistically show its new value as soon as a `setPreamp`/etc.
request resolved — but that's exactly the trap the scope span slider
were designed to avoid (see below): a resolved promise means the radio
*accepted* the write, not that it's still in that state a moment later,
and it says nothing about changes made from the front panel in the
meantime. The current version removes that optimism entirely:
`syncFunctionControl()`, `syncTuner()`, and `syncTxPower()` poll the
radio's actual current value via the matching `get*` request
(`getPreamp`, `getNoiseReduction`, `getNoiseBlanker`, `getNotch`,
`getFilter`, `getTuner`, `getTxPower`) and are the *only* thing that
updates a control's displayed state — a click/change handler fires the
*next* state's request and then immediately re-syncs to re-read the
confirmed value (rather than waiting for the next scheduled poll tick,
so cycling/selecting still feels responsive — typically one CI-V
round-trip, well under the 2s poll interval — without reintroducing
optimism: the control still only shows what was actually read back, not
what was requested). `startFunctionPolling()` also runs this for
everything on its own 2s interval regardless of clicks (deliberately
slower than the 500ms S-meter poll, and sequential rather than parallel
— several extra CI-V round-trips every tick would otherwise meaningfully
load the half-duplex serial bus for a class of setting that doesn't need
sub-second freshness), starting once immediately on connect so the real
initial state shows up without waiting for the first interval tick, and
stopping on disconnect alongside meter polling. Unlike the dropdown
version this replaced, there's no "skip while focused" guard needed for
the toggle buttons themselves — a button click is instantaneous, with
no lingering open-picker state to protect the way a `<select>` had
(TX power, covered below, is still a real `<select>` and does keep this
guard, since it's a genuine dropdown per the request that added it).

## Scope span selection

A single horizontal `<input type="range">` under the scope, labeled
"Scope Span" (`#scope-span-slider`/`#scope-span-value` in `index.html`),
replaced what used to be eight separate buttons — one per
`2.5/5/10/25/50/100/250/500 kHz` (`SPAN_OPTIONS` in `app.js`) — per
explicit request. Selecting a position sends the corresponding span via
the `setScopeSpan` WebSocket request. These eight values map *exactly*
onto all 8 of the radio's fixed span presets — confirmed against Icom's
own official IC-7300 CI-V reference manual, which lists the presets
directly in Hz (2.5/5/10/25/50/100/250/500 kHz), not as "±" half-widths.
An earlier version labeled the (then-)buttons with a "±" prefix and
doubled the requested value, based on a less authoritative source that
turned out wrong on both counts — see `docs/civ-notes.md` for the full
history.

**The slider's value is an index into `SPAN_OPTIONS` (0–7), not a Hz
value.** The eight span presets are wildly uneven in Hz — 2.5 kHz to 500
kHz, a 200x range — so a slider scaled directly to Hz would bunch every
useful low-end position into an unusable sliver at one end of the track.
Indexing instead gives exactly the requested "eight settings at equal
positions along its range," independent of how uneven the underlying Hz
values are. `scopeSpanSlider.max` is set programmatically from
`SPAN_OPTIONS.length - 1` (the `max="7"` in `index.html` is just a
hardcoded fallback matching it at time of writing).

Interaction follows the same two-listener split already used for the RX
gain slider (`#rx-gain-slider`): an `'input'` listener updates the
`#scope-span-value` label live while dragging, with no network request;
a separate `'change'` listener fires the actual `setScopeSpan` request
once, on release (or an arrow-key commit) — so dragging across several
intermediate positions costs one request for wherever the operator
actually settles, not one per position crossed.

Slider position is still driven by **observed reality, not drag intent**:
`updateSpanSliderFromRange()` runs on every incoming scope line (via the
same `onRangeUpdate` callback that updates the range labels/axis ticks),
comparing the actual reported width (`hi - lo`, **halved** — see "Real
bug found" below) against `SPAN_OPTIONS` and moving the slider (and
label) to whichever entry currently matches — dragging the slider fires
the request but does **not** optimistically leave the slider claiming
that value until the radio confirms it via the next scope line. This
mirrors the same principle already used for the range labels: the
display should never claim something is true that the radio hasn't
actually confirmed by reporting it. A reported half-width that doesn't
exactly match any `SPAN_OPTIONS` entry (shouldn't happen in normal
operation — see `docs/civ-notes.md`) leaves the slider at its current
position rather than guessing.

**Real bug found: the RF range labels/gridlines were showing half the
actual displayed width.** `ScopeDisplay#pushLine()` computed
`lo = centerFreq - span/2, hi = centerFreq + span/2` — i.e. treated the
scope-line header's `span` field (see `docs/civ-notes.md`'s "Spectrum
scope" section) as the *total* width, matching how `SPAN_OPTIONS`/the
slider label it ("100 kHz" span). Confirmed on real hardware, that's
wrong: the field is the width to **each side** of center, so a "100 kHz"
span tuned to 7100kHz actually sweeps 7.000-7.200MHz (±100kHz, 200kHz
total), not 7.050-7.150MHz. The scope-range labels above/below the
canvases, the 50kHz gridlines, and the tuning marker's horizontal
position were all quietly off by this same factor, since they all derive
from the same `lo`/`hi` pair. Fixed by dropping the `/2` in `pushLine()`
(`lo = centerFreq - span, hi = centerFreq + span`); `updateSpanSliderFromRange()`
was updated to match by halving the observed `hi - lo` width back to a
one-sided value before comparing it against `SPAN_OPTIONS`. This is
purely a client-side interpretation of the value the radio already
reports — the actual `setScopeSpan`/`27 15` wire request is untouched
and still sends the literal preset value confirmed against Icom's
manual (see `docs/civ-notes.md`); only how the reported result is turned
into an on-screen range changed. `ScopeDisplay`'s canvas-drawing methods
aren't unit-testable in Node (no DOM — see the note atop
`test/scope-display.test.mjs`), so this was verified against a real
radio rather than an automated test.

The default span is still auto-requested by the client, exactly **once
per page load**, the first time it learns scope is enabled — guarded by
`hasRequestedDefaultSpan`, deliberately not re-fired on reconnect (a
network blip and automatic WS reconnect shouldn't silently reset a span
another operator had since chosen). This stays client-triggered even
after the wire format was corrected against Icom's official manual (see
`docs/civ-notes.md`) — span is still not set automatically at server
startup, on the principle that the critical startup path shouldn't
depend on a command whose exact byte layout, while now much
better-grounded than before, still isn't independently hardware-confirmed
the way frequency encoding is. Requesting it from the client instead
means it happens naturally later, well after server startup has already
succeeded, and a failure only affects that one request — never server
health, audio, or anything else.

## Band button highlighting

The band chips (`BANDS` in `app.js`) now highlight the currently-tuned
band the same way the mode chips do — `updateBandButtons(hz)` toggles
`chip--active` on whichever band's range (`BAND_RANGES`, via
`bandNameForFrequency()` — already used for FT8's own band-change
detection) contains the current frequency, clearing every chip if the
frequency falls outside all of them (e.g. an out-of-band QRG, or before
the first frequency is known). It's called from `updateFrequencyDisplay()`
itself, the single function every frequency-change path already funnels
through (the initial connect snapshot, a band-chip click, a freq-step
button, another client's broadcast frequency change, and FT8's own
auto-tune) — so, like span highlighting above, this reflects the actually
confirmed frequency rather than needing every one of those call sites to
separately remember to update band highlighting too.

## Waterfall/scope color scheme

The trace and waterfall both color amplitude via `amplitudeToColor()` in
`scope.js`, which now uses **Google's "Turbo" colormap**
(https://research.google/blog/turbo-an-improved-rainbow-colormap-for-visualization/),
per explicit request, replacing this project's own earlier hand-tuned
blue/cyan/green/yellow/red heatmap (which had gone through two rounds of
calibration against real reference waterfall screenshots the user
supplied — see this doc's git history if that's ever needed again).

`turboColormap()` in `scope.js` is Google's own published polynomial
approximation of the full 256-entry Turbo lookup table — the exact GLSL
coefficients from
https://gist.github.com/mikhailov-work/0d177465a8151eb6ede1768d51d476c7
("Turbo Colormap Polynomial Approximation in GLSL", © 2019 Google LLC,
Apache-2.0), transcribed rather than re-derived or approximated from
memory (fetched and cross-checked from two independent sources before
use). This was chosen over hand-copying a handful of stops from the LUT
because it reproduces the actual designed colormap continuously across
the whole domain. It's explicitly an *approximation*, not the exact LUT —
by Google's own account it can be off from the true table by roughly a
dozen-ish RGB levels right at the two extremes (tightest through the
middle) — a known, accepted trade-off for not shipping/interpolating a
256-entry table, and well below what's visually distinguishable on a live
waterfall.

**Amplitude → colormap mapping.** Per explicit confirmation, the full
0-255 raw amplitude range maps linearly onto Turbo's full `[0,1]` domain
(dark blue/purple at 0, through cyan/green/yellow, to dark red at 255) —
the standard, textbook way to apply a sequential colormap to a scalar
range. This is a deliberate *change* in behavior from the previous
palette, not just a hue swap: the old scheme pinned everything at or
above S9 (raw 126, matching `smeter.js`'s confirmed S9 threshold) to the
same solid red, so a very strong signal (e.g. S9+40dB) looked identical
to a signal right at S9. Turbo has no such pin — a signal well above S9
now renders visibly further along the ramp (redder still) than one right
at S9, rather than looking the same. `test/scope-display.test.mjs` covers
the exact colormap output at several amplitudes (computed directly from
the published coefficients, not eyeballed) and confirms this pinning
behavior is gone.

## Antenna tuner controls

Two separate buttons next to the Speaker button (below the S-meter) —
an on/off toggle and a one-shot "Tune" action — both go through
`CivDriver#setTuner()` (see `docs/civ-notes.md` for why 0/1/2 share one
CI-V command despite being conceptually different UI actions). The
toggle button's displayed on/off state comes from `syncTuner()`, part of
the same polling loop that keeps the Preamp/NR/NB/Notch/Filter toggle
buttons synced (see above) — not from assuming a click succeeded, for
the same reason: a resolved `setTuner` request only confirms the write
was accepted, not that the state hasn't since changed (front panel or
otherwise). The Tune button doesn't show a "tuning..." state: the radio
doesn't report tuning progress or completion over CI-V in a way this
project decodes, so it just fires the request and relies on the
standard error toast if it fails — same honesty principle as everywhere
else in this UI: no status is shown that hasn't actually been confirmed.

## Transmit power dropdown

A real `<select>` (`TX_POWER_OPTIONS` in `app.js`, 100/75/50/25/5W) on
the right-hand side of the same row as Speaker/Tuner/Tune (`.tx-power`
uses `margin-left: auto` within `.controls-row`'s flexbox to push it
there, rather than the row's other buttons needing any change). Follows
the exact same "never assume, only show confirmed" pattern as everything
else in this UI: a `'change'` handler fires `setTxPower`, then
immediately calls `syncTxPower()` to re-read the confirmed wattage
rather than assuming the selection took effect, and `syncTxPower()` also
runs on the shared 2s poll alongside the other function controls. Unlike
the toggle buttons, this control *does* keep the "skip sync while
focused" guard (`document.activeElement === txPowerSelect`) that the
Preamp/NR/NB/Notch controls no longer need now that they're buttons — a
native `<select>`'s picker can stay open mid-choice, and a poll landing
during that window shouldn't yank the selection away.

See `docs/civ-notes.md` for the CI-V side, including a real bug found
and fixed there: the byte encoding this originally used (standard BCD)
got outright rejected (NG) by a real radio, root-caused to an invalid
byte value for higher wattages, and corrected to reuse the packing
already confirmed for the S-meter. Worth repeating the remaining
caveat: the watts-to-raw-level conversion itself is still a linear
assumption, not confirmed against a real wattmeter or the radio's own
front-panel power reading — and `test/manual-txpower-diagnostics.js`
exists specifically for verifying the byte encoding further if it's
still wrong on some other radio (safe to run: it never engages PTT).

## RX gain slider

A vertical range input (`#rx-gain-slider`) sits to the right of the
scope canvases, inside a new `.scope__body` flex row that wraps them
both — `.scope__canvases` picked up `flex: 1` so it still fills the
remaining width exactly as before, the slider just claims a fixed
20px-wide column beside it. Orientation uses `writing-mode: vertical-lr`
(the modern, broadly-supported way to orient a range input vertically)
plus a `-webkit-appearance: slider-vertical` fallback for older
WebKit/Blink.

**Real bug found and fixed**: the first version assumed `writing-mode`
alone would put max at the top and min at the bottom by default,
matching the "top = 255, bottom = 0" requirement with no further
changes needed — that assumption was wrong on real testing, which showed
it rendered reversed (min at top). Fixed by adding `direction: rtl`
alongside `writing-mode: vertical-lr`, which flips the value-progression
direction for that mechanism specifically — the `-webkit-appearance:
slider-vertical` fallback needed no corresponding change, since it's a
separate, older rendering path that already defaults to top=max on its
own and isn't affected by `direction`. Both mechanisms should now agree
on the same orientation, though this still hasn't been exhaustively
verified across every browser engine — if it's ever found reversed again
on some specific browser, that's the first place to look.

Same "confirm then re-sync" pattern as every other control in this UI,
with one difference driven by the control itself being continuous rather
than discrete: the actual CI-V write (`setRxGain`) only fires on the
`change` event (drag released / value committed), not on every `input`
tick — a request per pixel of drag would flood the serial bus the same
way a poll-per-tick would. The label next to the slider is a **static
"RX Gain"**, not a live numeric readout (per explicit request — an
earlier version showed the current 0-255 value here, updated live on
`input`); there's nothing left to update on every drag tick now beyond
the slider thumb's own position, which the browser already renders
without any JS involvement. `isDraggingRxGain` (set on `pointerdown`/`pointerup`)
guards the periodic `syncRxGain()` poll the same way the TX power
dropdown's focus guard does, so a poll landing mid-drag can't yank the
handle out from under an in-progress adjustment — `pointerdown`/`pointerup`
rather than focus-based, since a slider drag doesn't reliably keep
`document.activeElement` pointing at it the way a `<select>`'s open
picker does, especially on touch.

## CW iambic paddle

When the mode is CW, `setCwPaddleVisible()` (called from
`updateModeButtons()`, so it reacts identically whether the mode changed
because *this* client clicked a mode button or because the radio itself
pushed an unsolicited mode change) hides the single PTT button and shows
two buttons instead — Dot (left) and Dash (right) — plus a small WPM
number input, defaulting to 15. Releases the paddle and force-ends any
in-progress keying session first if the mode changes away from CW mid-key.

**Real bug found and fixed**: the JS logic above was correct from the
start, but a CSS mistake meant it had no visible effect when leaving CW
mode — `.cw-paddle` set `display: flex` unconditionally, which has the
same specificity as the browser's own `[hidden] { display: none }` rule
and, being an author style, wins the tie over that user-agent rule
regardless of source order. The `hidden` attribute was being toggled
correctly the whole time; the paddle just never actually disappeared
because of it. Fixed with `.cw-paddle[hidden] { display: none; }`, the
exact same targeted-override pattern this project already used once
before for `.scope__placeholder[hidden]` — worth remembering as the
general fix whenever an element combining `hidden` with any explicit
`display` value doesn't toggle as expected.

**The real limitation, worth being direct about**: there is no CI-V
primitive for "key down for N milliseconds." The only way to produce a
timed dot or dash is toggling the exact same `setPtt` command used for
voice PTT, once per element, over the full WebSocket + serial round
trip. At typical keying speeds this will be visibly less precise than a
hardware keyer or the radio's own internal one — the 15 WPM default is a
deliberately conservative starting point given that latency, not a claim
of clean, contest-grade timing. `runKeyerLoop()` implements standard
iambic behavior (a dot is 1 unit, a dash is 3, the inter-element gap is
1, `unit_ms = 1200 / WPM` — the conventional PARIS-word formula) and
alternates dot/dash automatically when both paddles are squeezed
together, but none of that changes the fundamental round-trip-latency
ceiling.

**Shares `pttActive`/`updatePttVisual` with the main PTT flow**, for one
concrete reason: `startMeterPolling()` checks `pttActive` to decide
whether to show S-meter or VSWR (see the S-meter section above), so CW
keying needs to be visible to that the same way voice PTT already is.
It does *not* go through `engagePtt()`/`releasePtt()` themselves, though
— those also start/stop the microphone audio pipeline, which CW keying
has no use for; `startKeyerSession()`/`endKeyerSession()` are separate,
lighter functions that only touch `pttActive` and the visual state.

**A gap in the main PTT watchdog, closed client-side.** The 10-minute
server-side fail-safe (see `docs/civ-notes.md`) resets on every PTT-off,
which is exactly right for normal keying (a real operator's natural
gaps between elements never accumulate toward the limit) — but it also
means a genuinely *stuck* paddle producing continuous keying for the
whole 10 minutes wouldn't hit that same backstop the way a held voice
PTT would, since each brief element gap keeps resetting the server's
timer. `runKeyerLoop()` tracks its own session start time and force-ends
the session with the same "automatically stopped" message pattern if a
single continuous keying session (from first paddle press to last
release) exceeds 10 minutes, independent of the server-side timer.

## CW decoder

**Server-side architecture** (`src/server/cw-decoder-bridge.js`): rather
than each connected client independently running DSP in the browser,
`CwDecoderBridge` taps the *same* raw PCM stream `AudioBridge` already
captures (`audioBridge.capture`, an `AlsaCapture` instance — the bridge
just attaches as an additional listener, no separate ALSA process of its
own) and decodes once, server-side, broadcasting decoded text to every
connected client over the existing control channel. This is a hard
dependency: CW decoding only exists when `AUDIO_RX_DEVICE` is configured
(see the README), the same way normal RX audio playback does — there's
no separate opt-in env var for it, since audio being configured is
already the actual prerequisite.

The bridge tracks mode and PTT state independently (subscribing to
`civ`'s `'mode'` events directly, and to a new internal-only `'ptt'`
event `ControlServer` now emits alongside its existing broadcast-to-
clients call — see `ws-server.js`'s `SET_PTT` handler and the watchdog's
forced-release path) and only attaches to the PCM stream while **both**
conditions hold: mode is CW, and PTT is not active. Pausing during PTT
is deliberate, not an oversight — there's nothing meaningful to decode
in our own TX audio or silence, and running the decoder against it would
just feed it garbage between elements of the operator's own keying.
Freshly entering CW mode (not just staying in it) resets the decoder's
prior state and re-reads the radio's current CW pitch, in case either
changed while a different mode was active.

Decoded output broadcasts as `EVENT.CW_TEXT` (`'cw-text'`), one event
per resolved character or word-gap space — not an accumulated string —
so the client (or any future client) renders its own display however it
chooses, the same "server relays raw events, client renders" pattern
already used for scope-line data.

**Client-side ticker** (`app.js`/`index.html`/`styles.css`): a text strip
under the S-meter, shown and hidden by the exact same `setCwPaddleVisible()`
mode check that swaps the PTT button for the CW paddle — both are
CW-mode-dependent UI, toggled together rather than via two separate
near-identical functions. Entering CW mode clears the ticker's
previously-displayed text, matching the server-side decoder's own reset
on entry, so a later CW session never opens with stale leftover text
from an earlier one.

Implemented as a fixed-width `overflow-x: hidden` container with the
text appended to a growing `<span>`, auto-scrolled to `scrollWidth` on
every update — a rolling-terminal pattern (always showing the latest
text, older text pushed off to the left) rather than a continuously
re-animating CSS marquee, which is both simpler and more robust. The
text buffer is capped at 500 characters (`CW_TICKER_MAX_CHARS`) so a
long CW session can't grow the DOM/string without bound.

**Three decoder algorithms ("CW1"/"CW2"/"CW3")**: `CwDecoderBridge` owns
three decoder instances side by side rather than one — `src/audio/cw-decoder.js`
(this app's original single-frequency Goertzel decoder, "CW1"),
`src/audio/hamfist-cw-decoder.js` (a port of Jonathan Dawson's FFT
multi-channel/histogram-classifier/beam-search "Hamfist" decoder,
https://github.com/dawsonjon/HamFist, "CW2"), and `src/audio/deepcw-decoder.js`
(a neural-network/CTC decoder ported from e04/deepcw-engine,
https://github.com/e04/web-deep-cw-decoder, "CW3") — and feeds PCM only
to whichever one is currently selected; the others sit idle rather than
burning CPU (or, for CW3, inference time) on output nobody sees. The CW
mode chip doubles as the switch: its label always reads "CW 1", "CW 2",
or "CW 3" (not a neutral "CW"), and a click while CW mode is already
active cycles the variant (CW1 -> CW2 -> CW3 -> CW1) instead of
re-requesting the same mode — the same "second click repurposed" pattern
the FT8 chip already uses for its FT8/FT4 protocol toggle (see
`toggleFt8Variant()`). Switching resets whichever decoder becomes newly
active, so it never resumes with stale (or simply empty, since it wasn't
being fed audio while inactive) state. See `REQUEST.SET_CW_DECODER_VARIANT`/
`EVENT.CW_DECODER_VARIANT` in `protocol.js` and `hamfist-cw-decoder.js`'s/
`deepcw-decoder.js`'s own top-of-file doc comments for how the algorithms
actually differ (FFT vs. Goertzel, per-bin gated noise floor vs. a scalar
EMA, histogram-based dot/dash/gap classification vs. fixed ratios,
Bayesian beam search with a ~9800-word autocorrect dictionary vs.
deterministic table lookup, for CW1 vs CW2 — vs. CW3's altogether
different approach: a small CNN+CTC neural network run via
`onnxruntime-node`, with no character-by-character timing model at all.
CW3 also behaves visibly differently in the UI: it batches 5-20 second
audio windows through the model rather than decoding live, so its output
arrives in bursts every several seconds instead of as each element is
keyed — an accepted UX tradeoff for a fundamentally different decoding
approach, not a bug. CW3 also depends on a native `onnxruntime-node`
binary existing for the host platform/architecture (bundled prebuilt
binaries cover 64-bit Raspberry Pi OS — Pi 4/5, i.e. `linux-arm64` — but
*not* 32-bit `armv7`/`linux-arm`); if that binary is missing, CW3's model
fails to load and the failure is surfaced as `EVENT.AUDIO_ERROR` while
CW3 is the active variant, rather than silently decoding nothing.

**A CSS pitfall avoided from the start this time**: `.cw-ticker-section`
includes an explicit `[hidden] { display: none }` override alongside its
own `display: flex`, the exact fix `.cw-paddle` needed reactively after
shipping without it (see above) — an element's own `display` value has
the same CSS specificity as the browser's `[hidden]` rule, and author
styles win that tie regardless of source order, so without the override
the `hidden` attribute would have had no visible effect here either.

**A real bug found against a user-recorded sample, not synthetic test
audio (`src/audio/cw-decoder.js`)**: the decoder's adaptive noise floor
is only updated from blocks classified "no tone" — this is what lets it
tolerate a signal that fades in and out. The synthetic tones this module
was originally tuned and tested against have perfectly instantaneous
on/off transitions, so in every test a block is always purely tone or
purely silence. A real recording (mic pickup of the radio's speaker,
room acoustics, lossy re-encoding) instead smears real, non-trivial
energy across the block or two right next to every mark's edge — still
under the momentary threshold, so classified "no tone", but far above
genuine background noise. Blending that straight into the noise floor's
exponential average pushed the floor up on every element of fast
keying: a positive feedback loop, since a higher floor raises the
detection threshold, which admits even more marginal "off" blocks next
time. Against a real 32-second user recording, this ran the threshold
past the tone's own peak magnitude within about two seconds of keying,
permanently silencing detection for the rest of the transmission even
though a strong, clean tone continued for another 15+ seconds — which
is exactly what "the decoder changes the GUI but never decodes
anything" looks like from the outside.

Tried and found insufficient: capping how much a single block can move
the floor in one step, and ramping a block's contribution in by how
long the current "no tone" streak has run (both slow the climb but
don't stop it — on the real recording the contaminating blocks were
typically only a few times the current floor, not one huge spike, so
the drift is gradual rather than a single outlier to filter out).

Fixed by anchoring a ceiling to the *signal* side instead of trying to
out-guess the noise side: `_signalPeak` tracks a decaying max of the
magnitude seen from actual tone-classified blocks, and the noise floor
is never allowed to climb past `_signalPeak / (toneThresholdMultiplier
* 2)`. This directly reflects the invariant the detector already
depends on (a genuine mark has to be `toneThresholdMultiplier` times
the noise floor to register as a mark at all), so it can't be pushed
past a real signal's own magnitude no matter how the "off" side drifts.
Verified against the real recording (after re-extracting it to raw PCM
and feeding it through the decoder directly, bypassing the audio
pipeline): decoding no longer stops partway through, and the recovered
text includes a plausible Australian callsign and CW procedural sign
(`VK2IO`, `K`) appearing twice — strong evidence the fix actually
recovers real content, not just that it avoids throwing. Character-level
accuracy on that specific recording is still imperfect (see
`test/cw-decoder.test.js`'s regression test for the reproduction, built
from synthetic audio with injected edge-bleed blocks rather than the
user's file itself, so it stays deterministic) — most likely the
remaining noise is a mix of genuine acoustic/codec artifacts from
phone-mic-recording the radio's speaker (a fundamentally different
signal than the clean ALSA PCM the live pipeline actually processes)
and this module's already-documented unit/WPM-tracking sensitivity to
a handful of anomalously short marks — which turned out to itself be a
fixable bug, not just an accepted tradeoff; see immediately below.

**A second real bug, found against three more user-recorded samples
(`src/audio/cw-decoder.js`)**: the WPM-tracking sensitivity flagged
above as "an accepted tradeoff, not a full fix" turned out to be fixable
after all once real recordings (rather than idealized synthetic tones)
exposed just how badly it could fail. The unit estimate is re-derived
from the *minimum* duration in a sliding window of recent marks — see
the constructor's doc comment for why a plain EMA over dot-classified
durations was replaced with this. The problem: a single implausibly
short mark entering that window — a brief noise blip or a
debounce-boundary artifact (`debounceBlocks * blockMs` is the shortest
duration the debounce logic can structurally produce, so this isn't
rare) rather than a genuine element — could collapse the estimate by
3-4x in one step. Every genuine mark afterward then reads as many
multiples of the now-far-too-small unit and gets classified a dash
regardless of what it actually was, feeding more artificially "long"
durations back into the window and locking the estimate at the wrong
speed for the rest of the message. Traced directly against a real
recording: a single 16ms blip at the 8.5-second mark preceded a long
run of otherwise-legible marks all coming out as dashes (`TTTT...`) for
the remainder of the transmission.

Fixed by not letting a mark's duration seed the window at all unless
it's at least 40% of the *current* unit estimate — a genuine gradual
speed-up still gets through fine (it arrives as a sequence of
consistently shorter marks, not one outlier, and adapts within a couple
of elements same as before), but an isolated implausible glitch no
longer collapses the estimate. This needed its own bootstrap case: for
the very first mark of a session (empty window, nothing to check the
40% ratio against), a *different* real recording showed the opposite
failure — several seconds of interference right at the start of the
file, before any real CW, misread as one enormous mark and used to seed
the window unconditionally, poisoning the initial unit estimate to over
a second with nothing yet in the window to outvote it. Fixed with a
generous absolute sanity range (roughly 2-120 WPM) for that one
bootstrap decision only; a bogus first "mark" outside it is discarded
rather than seeding anything, and the next candidate gets the same
chance. Both failure modes are regression-tested directly in
`test/cw-decoder.test.js` with synthetic audio reproducing each
(an injected mid-message glitch, and a bogus multi-second leading tone).

Verified against all four real user recordings collected so far: the
previously mostly-`T`/`E`-garbled output on two of them now recovers
the callsign `VK2IO` cleanly (matching the ID already confirmed from
the first recording), and the reported speed estimate across all four
files now sits in a plausible 11-45 WPM range instead of occasionally
running away past 70+ WPM. Character-level accuracy still isn't
perfect on every file — real acoustic/codec noise (see above) remains a
genuine, separate limitation — but the systematic "one bad mark wrecks
the rest of the message" failure is gone.

**A third real bug, found against a user recording that decoded
*nothing at all* rather than garbled output (`src/audio/cw-decoder.js`,
`src/server/cw-decoder-bridge.js`)**: unlike the two bugs above, this one
produced zero visible output and zero visible error — from the outside,
completely indistinguishable from "the decoder is just broken". Root
cause, found by converting the user's uploaded recording to raw PCM and
measuring its actual tone directly: the recording's real CW pitch was
~787Hz, while the decoder was sitting at its 600Hz default — a gap far
wider than the Goertzel filter's selectivity can bridge. Compounding it,
`CwDecoderBridge._refreshPitch()` swallowed a failed `getCwPitch()` CI-V
read completely silently, so if that specific read ever failed (a risk
already flagged elsewhere in this codebase for this exact command group —
see `driver.js`'s `_decodeMeterReply()` doc comment), the decoder would
stay stuck at 600Hz indefinitely with nothing anywhere to suggest why.

Fixed with two independent changes, so neither one alone has to be
perfect for CW decoding to keep working:

1. **The decoder no longer depends on being told the right pitch.**
   `CwDecoder` now runs its own periodic self-calibration
   (`autoCalibratePitch`, on by default): a coarse Goertzel-bank scan
   across the IC-7300's documented CW pitch range (300-900Hz, 10Hz
   steps — see `LEVEL_SUBCMD.CW_PITCH` in `src/civ/commands.js`) over the
   most recent ~250ms of raw audio, on its own rolling ring buffer
   (`_calibBuffer`) independent of the block-sized decode pipeline. The
   scan's peak-to-median magnitude ratio across the whole scanned range
   gates whether to trust and retune to it — a real narrowband CW tone
   stands out sharply from the rest of the band, while broadband noise
   doesn't. This is deliberately *not* compared against the decoder's own
   `_noiseFloor`/`_signalPeak`, since those are only ever measured at
   whatever `pitchHz` currently is — exactly the value that might be
   wrong, including "wrong enough that nothing has ever been classified
   as a tone yet" (both still sitting at their initial, meaningless
   defaults). Verified against the real recording:
   `calibrationContrastThreshold = 15` sits with margin between the
   actual tone's measured ratio (consistently >15x) and room noise after
   the transmission ended (stayed under 7x). Retries at a fast cadence
   (`calibrationRetryIntervalMs`, 500ms) until the first successful lock
   — a single 250ms scan window can land on a gap between marks even
   during genuine CW — then drops to a slower cadence
   (`calibrationIntervalMs`, 3s) just to track drift once locked. Emits a
   `'pitch'` event on every retune; `reset()` clears all of this state
   (the ring buffer, both cadence timers, and the "locked once" flag), so
   a fresh CW session recalibrates from scratch at the fast retry cadence
   rather than inheriting stale timing from whatever came before it (see
   the reset-specific regression test in `test/cw-decoder.test.js`).
2. **A failed pitch read is now visible.** `_refreshPitch()` in
   `cw-decoder-bridge.js` broadcasts `EVENT.RIG_ERROR` naming the
   underlying failure instead of swallowing it, so a persistently failing
   read (a real firmware/radio problem, distinct from the
   auto-calibration fix above, which only papers over *this specific*
   symptom) is still surfaced as worth investigating rather than silently
   invisible.

Verified end-to-end against the user's actual uploaded recording
(converted to raw PCM via ffmpeg): starting the decoder at the wrong
600Hz default with auto-calibration produced a clear, recognizable
partial decode ending correctly in "DE VK3XU K" — a real, standard CW
sign-off — versus decoding nothing at all beforehand. Character-level
accuracy earlier in that same recording is still imperfect; this is a
phone-mic-in-a-room recording (reverb and room noise smear element
boundaries in a way the live deployed pipeline's direct ALSA capture from
the radio never has to deal with), so it's a substantially harder test
signal than what actually reaches this decoder in normal operation — not
a sign the calibration fix itself is incomplete. New synthetic-audio
regression tests for the calibration feature itself (self-correction from
a wrong starting pitch, no false retuning against pure noise, disabled
via `autoCalibratePitch: false`, and correct state clearing on `reset()`)
are in `test/cw-decoder.test.js`; the bridge's `RIG_ERROR` broadcast on a
failed pitch read is regression-tested in `test/cw-decoder-bridge.test.js`.

**A fourth real bug, found from a fresh "not reliably decoding any
messages" report — and this one reproduced with clean, noise-free
synthetic audio, no real recording needed at all (`src/audio/cw-decoder.js`)**:
unlike the three bugs above, this one wasn't intermittent or
noise-dependent — it was purely algorithmic, deterministic, and hit an
extremely common case. `_recentMarkDurations` (the sliding window
`_onStateChange()` uses to re-derive the unit/speed estimate) let *any*
classified mark seed or update it, dot or dash alike, on the reasoning
that the window's minimum will always eventually settle on the true dot
length. That reasoning has a hole: while the window doesn't yet contain
a single genuine dot — most obviously right at the very start of a
message — a dash seeding it directly drags the estimate up to roughly a
dash's length instead of a dot's, and every dash immediately afterward
then reads as too few multiples of that inflated unit and misreads as a
dot. "CQ" (`-.-. --.-`) — the single most common CW call there is —
decoded as "BQ" (its second dash misread as a dot) on every one of ten
different noise seeds tried, *and* with plain clean audio and zero noise
at all; a message opening with a dash-heavy digit fared worse still —
"0700 UTC" (`0` is `-----`) decoded as nothing but a lone "?". Given how
often a real transmission opens with "CQ" specifically, this alone
plausibly explains a user's impression that the decoder simply "isn't
reliably decoding any messages": the very callsign/call being watched
for was the part most likely to come out wrong.

Fixed by only ever letting a mark actually *classified as a dot*
(`!isDash`, evaluated against whatever unit estimate is current the
moment it's classified) seed or update the window — a mark classified as
a dash is never trusted as a stand-in for "one unit", cold-start or not.
This doesn't reinstate the second bug above (the slow-callsign-then-
speeds-up case the window was widened to fix in the first place): that
recovery specifically depends on a now-fast dash reading as *shorter*
than the stale (too-slow) unit estimate at the moment it's checked,
which means it gets classified `isDash: false` — a "dot" — right then,
so it's still allowed through under the new rule exactly as before.
Verified: the speed-jump regression test above still passes unchanged,
and two new ones reproduce "CQ CQ K" and "0700 UTC" decoding correctly
end-to-end (`test/cw-decoder.test.js`).

## RTTY decoder

The RTTY mode chip was removed for a while (its UI slot was given to
FT8) and has since been restored, alongside FT8 rather than instead of
it — both now coexist as their own chips (`MODE_CHIPS` in `app.js`).
Added at the same time: a real RTTY decoder, mirroring the CW decoder's
overall architecture (`src/audio/cw-decoder.js`/`cw-decoder-bridge.js`
above) as closely as the two modes' actual signal formats allow — same
Goertzel-based tone detection (`rtty-decoder.js` reuses
`goertzelMagnitude` from `cw-decoder.js` directly rather than
reimplementing it), same server-side-decode/broadcast-to-clients shape,
same automatic mode/PTT-driven activation with no separate `REQUEST`
needed (RTTY, like CW and unlike FT8, is a genuine CI-V hardware mode —
see `MODE.RTTY` in `src/civ/commands.js` — so there's nothing to
manually arm/disarm; entering the mode is the only signal needed).

### Why RTTY needed a different decoding technique than CW

CW decodes a single tone against silence, with the operator's own keying
speed unknown up front and needing continuous adaptive tracking (see the
CW decoder section above). RTTY is the opposite shape: the "tone" is
never absent (the line is always either mark or space — FSK, not
on/off keying), but the *baud rate is fixed and known in advance* — the
explicit request was specifically 45.45 baud, the standard amateur rate.
That makes RTTY's decode problem look far more like a UART receiving
asynchronous serial data than like decoding Morse: watch for the
mark-to-space transition that signals a start bit, then sample the line
at the nominal center of every subsequent bit position for the rest of
a fixed-length character frame (1 start + 5 data + a stop bit), rather
than adaptively estimating anything the way CW's dot-length tracking
does. `RttyDecoder` (`src/audio/rtty-decoder.js`) implements exactly
that: a `_frame` state machine tracks the current character's start
time and how many of its 7 bit-positions have been sampled so far, with
no per-message speed adaptation needed at all since the baud rate never
changes mid-transmission the way CW operator speed can.

### Standard tones and frame format, verified not guessed

Per this project's established practice of checking real-world specs
rather than assuming them: the default mark/space tones (2125Hz /
2295Hz, a 170Hz shift with mark the *lower* tone) were confirmed against
multiple independent sources (AA5AU's own RTTY primer explicitly states
"the standard mark and space tones are 2125 Hz and 2295 Hz... mark being
the lower frequency," cross-checked against Wikipedia's Radioteletype
article, which independently corroborates the same shift and gives the
same absolute pair as the "US" convention, distinct from a European
2125/1955Hz convention that also exists but wasn't asked for). Both are
constructor options (`markHz`/`spaceHz`), not hardcoded, the same way
`CwDecoder`'s `pitchHz` is configurable rather than fixed — a different
band-plan/rig setup could substitute a different pair with no code
change. The 45.45 baud rate and the 1-start/5-data/stop-bit frame shape
are likewise the standard amateur convention (Wikipedia's own
Radioteletype article: "Amateur radio transmissions are almost always
45.45 baud," using "the Baudot code or ITA-2 5 bit alphabet," with "a
start bit... then... the 5 data bits, finishing with a stop bit... 1,
1.5 or 2 bits" long) — this decoder validates a stop bit sampled at the
nominal 1-bit position, which is enough to confirm framing and naturally
leaves the real ~0.5-bit remainder of a 1.5-bit stop period as margin
before the next start-bit edge, without needing to explicitly wait it
out.

### The Baudot/ITA2 code table itself needed a third source to resolve

Baudot/ITA2's 32 five-bit codes map to two different character sets
(LTRS and FIGS, toggled by two special shift codes within the alphabet
itself, `11111`/`11011`) — structurally nothing like Morse's single flat
lookup table, so `BAUDOT_TABLE` in `rtty-decoder.js` had to be built from
scratch rather than adapted from `MORSE_TABLE`. The first two published
references checked (a "bits as transmitted, LSB first" table and a
separately-sourced "MSB first" table) agreed with each other once one
was bit-reversed against the other for the *letters* case and most of
the *figures* case — but disagreed on a handful of specific figures-case
assignments (S, J, H, Z), because these genuinely differ between
national ITA2 variants (a real ambiguity in the underlying standard
landscape, not sloppy sourcing) and the specifically **US-TTY**
convention amateur RTTY actually uses needed a third, hex-indexed
reference to settle definitively: US-TTY figures-case S is BEL (not the
apostrophe some European/plain-ITA2 tables give it), H is `#` (not
`£`), J is the apostrophe, and Z is `"` (one source's `+` for this cell
was rejected once the other two agreed against it). D (`$`) and V (`;`)
were consistent across every source checked and needed no tie-breaking.
See `rtty-decoder.js`'s own doc comment for the full source-by-source
account, and `test/rtty-decoder.test.js` for regression coverage
specifically pinning these six letters' figures-case assignments against
silently reverting to the wrong national variant.

Deliberately NOT implemented: "unshift on space" (some RTTY software
auto-reverts to LTRS on receiving a space character, as a defense
against one lost FIGS/LTRS shift code garbling everything after it) —
a reasonable robustness feature some terminal software adds, but outside
what was actually asked for. A single mis-decoded shift code can
therefore garble the rest of a transmission's case interpretation until
the next explicit shift arrives; a future enhancement if it turns out to
matter in practice.

### Getting the frequency resolution right needed catching a real bug against synthetic audio, not real recordings this time

An earlier draft of this decoder used the same short (~4ms) Goertzel
block CW's decoder uses. Direct testing against synthetic mark/space
tones (before this was ever wired into the bridge, let alone tried
against real audio) immediately caught the bug: a 4ms window's Goertzel
bin spacing (`sampleRate / windowSamples` = 48000/192 ≈ 250Hz) is
*wider* than the entire 170Hz mark/space shift, so both target
frequencies rounded to the literal same bin — `goertzelMagnitude()`
returned numerically identical values for the mark and space tones,
making them completely indistinguishable regardless of noise or
threshold tuning. This is a fundamentally different failure mode from
any of CW's real-recording bugs above: CW only ever needed to tell tone
from silence, so its 8ms block's coarser resolution was never a
correctness problem for that decoder, and nothing about porting the
"same Goertzel technique" pattern by itself would have surfaced this —
it took building a synthetic mark-tone-vs-space-tone test harness and
checking actual magnitude numbers to catch it before real audio ever
touched this code.

Fixed by decoupling frequency resolution from timing resolution: rather
than one fixed block size serving both jobs, `RttyDecoder` maintains a
sliding analysis window (a ring buffer of the last `windowMs` — default
10ms, giving 100Hz bin spacing, comfortably under the 170Hz shift — of
raw audio, the same ring-buffer technique `CwDecoder`'s own pitch-
calibration scan already uses) and re-evaluates it every `stepMs`
(default 2ms) rather than only once per disjoint block. This keeps
enough frequency resolution to cleanly separate the two tones while
still placing bit-sample-point timing to within a couple of milliseconds
— small relative to a ~22ms bit — rather than being forced to choose one
or the other. Verified with a direct round-trip test (encode a known
message to synthetic mark/space audio, decode it back, compare strings)
before writing any of the bridge/UI wiring, and again with injected
noise at multiple amplitudes (`test/rtty-decoder.test.js`) — a full CQ
call, a pangram exercising every letter plus FIGS-case digits/
punctuation, and a moderately noisy (4:1 amplitude SNR) signal all
round-trip exactly; heavier noise is only required to degrade gracefully
(no exception), not to still decode correctly.

### Client-side ticker

A second ticker, `#rtty-ticker-section`/`#rtty-ticker`/`#rtty-ticker-text`
in `index.html`, deliberately reusing the *existing*
`.cw-ticker-section`/`.cw-ticker__label`/`.cw-ticker`/`.cw-ticker__text`
CSS classes rather than duplicating them under RTTY-specific names —
presentationally it's the exact same "label + scrolling mono-text
strip" shown by the CW ticker, just fed by `EVENT.RTTY_TEXT` instead of
`EVENT.CW_TEXT` (see `app.js`'s `rtty-text` listener, mirroring the
`cw-text` one exactly down to the 500-character cap and
scroll-to-latest behavior). `setRttyTickerVisible()` mirrors only the
ticker-visibility half of `setCwPaddleVisible()` — RTTY has no manual
keying UI to swap the PTT button out for (this is decode-only, matching
what was actually requested), so there's no paddle-swap logic to port,
just show/hide-and-clear the ticker on entering/leaving RTTY mode (and
also on entering FT8 mode, the same way the CW paddle is hidden then
too — `enterFt8Mode()` now calls both `setCwPaddleVisible(false)` and
`setRttyTickerVisible(false)`).

### Known limitations

- **No mark/space tone auto-calibration.** CW's decoder learns and
  corrects its own tone frequency from received audio
  (`autoCalibratePitch` — see above); RTTY's decoder does not, and there
  is no CI-V readback for RTTY's AFSK tones the way there is for CW's
  pitch (`civ.getCwPitch()`) to seed one from in the first place. If a
  station or rig setup doesn't use the standard 2125/2295Hz pair, the
  mark/space frequencies need a code-level `markHz`/`spaceHz` override
  today (see `RttyDecoderBridge`'s constructor) rather than anything
  configurable from the UI.
- **No "unshift on space"** — see above.
- **No RTTY TX** — this is decode-only, matching the actual request
  ("implement an RTTY decoder"); there's no synthesized-Baudot-waveform
  transmit path the way FT8 has one.
- Like CW, this is a genuinely lossy, best-effort process — QRM, fading,
  mistuning, and multipath can all garble real off-air RTTY the same way
  they'd garble a real hardware terminal unit's copy. No real off-air
  recording has been used to verify this decoder yet (unlike CW, which
  was corrected against several real user-supplied recordings after
  shipping) — everything above is synthetic-audio-verified only so far.

### Real bug found: the decoder couldn't handle reversed mark/space polarity, so it decoded nothing at all against some real signals

A user reported that a RTTY signal their IC-7300's own built-in decoder
copied cleanly produced no output at all from this app's decoder — not
garbled text, nothing. The cause: `RttyDecoder` had exactly one fixed
mark/space tone-to-role mapping baked in (`markHz`/`spaceHz`, tuned to the
standard 2125/2295Hz pair), with no way to invert which tone meant "mark"
and which meant "space". RTTY normal-vs-reversed polarity genuinely isn't
predictable in advance from the radio's mode alone — it depends on both
the transmitting and receiving stations' equipment/mixing scheme, which is
exactly why every real RTTY terminal program (fldigi, MMTTY, and the
IC-7300's own decoder, which demodulates FSK internally rather than
searching two fixed audio tones) provides a manual "Reverse" toggle rather
than deriving it from anything else. Against a signal using the opposite
polarity from what this decoder assumed, every mark/space classification
came out inverted, which breaks start/stop-bit framing validation from the
very first bit of the very first character onward — indistinguishable from
"no signal at all", exactly matching the reported symptom. This was a
previously-known gap (see git history), but its actual real-world impact
— total decode failure, not degraded copy — wasn't clear until this
report.

Fixed by giving `RttyDecoder` a `reversed` constructor option and a
runtime `setReversed(reversed)` method (see `src/audio/rtty-decoder.js`),
independent of `setTones()` — retuning frequencies doesn't silently
un-reverse, and reversing doesn't forget a custom tone pair. This is
exposed as a "Reverse" checkbox next to the RTTY ticker (visible only
while RTTY mode is active, alongside the ticker itself and the trace
canvas's RTTY offset marker — see `setRttyTickerVisible()`), wired through
`REQUEST.SET_RTTY_REVERSED`/`EVENT.RTTY_REVERSED` and
`RttyDecoderBridge`'s `'rtty-reversed'` listener, which also resets the
decoder afterward to clear any in-progress frame/bit-sync state built up
under the old (now-wrong) polarity assumption. Unchecked by default — a
signal that already decodes fine shouldn't need touching; the operator
flips it only when RTTY mode produces no ticker output despite a
confirmed signal.

### Testing boundary for RTTY

Same split as CW's own testing boundary: `src/audio/rtty-decoder.js`
is fully unit-tested in `test/rtty-decoder.test.js` against synthetic
audio built by reverse-looking-up the real `BAUDOT_TABLE` (so test
fixtures can't silently drift out of sync with the real table, the same
principle `test/cw-decoder.test.js`'s `CHAR_TO_MORSE` reverse-lookup
follows) — covering the LTRS/FIGS shift mechanism itself, the six
specifically-US-TTY figures-case assignments called out above, default
tone/baud values matching the sourced standard, clean-signal round
trips (a CQ call, a full pangram exercising every letter plus FIGS-case
digits/punctuation, embedded CR/LF), deterministic seeded-noise trials
at multiple amplitudes, pure-noise/silence producing no false decodes,
`reset()` correctly clearing both an in-progress character frame and a
stuck shift state, and per-instance tone independence
(`markHz`/`spaceHz`/`setTones()`). `src/server/rtty-decoder-bridge.js`
is tested in `test/rtty-decoder-bridge.test.js`, mirroring
`test/cw-decoder-bridge.test.js`'s hand-rolled-stub approach exactly
(`StubCiv`/`StubControlServer`/`StubDecoder`/`StubCapture`, verified via
`listenerCount('data')` on the stub capture) minus the CW-pitch-specific
cases that don't apply here (no CI-V tone readback to refresh or fail).
The client-side ticker/mode-chip wiring has no automated test, for the
same reason the rest of the DOM-facing client code doesn't (see
"Testing boundary" below).

## Screen title (`SCREEN_TITLE` environment variable)

The browser tab title and the on-screen `<h1>` heading both come from
the server at connect time, not from the static HTML — `index.html`
ships with a hardcoded "SPARC PiRO" as a fallback (briefly visible
before the WebSocket connects, and shown if it never does), but
`link.addEventListener('connected', ...)` in `app.js` overwrites both
`document.title` and `panelTitleEl.textContent` from
`data.screenTitle` on every connection. The server reads this from the
`SCREEN_TITLE` environment variable (defaulting to `"SPARC PiRO"` if
unset — see `src/server/index.js`) and includes it in
`ControlServer`'s cached `this.state`, which is what gets sent as part
of the initial snapshot to every newly-connected client (the same
mechanism frequency/mode/etc. already used) — no new event type or
static-file templating needed, this reuses the existing snapshot
delivery path entirely.

**App version, next to the title.** Per explicit request ("Include the
app version number in small text (same size as the "Connected" message)
to the right of the SCREEN_TITLE"), `data.appVersion` rides in the same
`'connected'` snapshot as `screenTitle` — `src/server/index.js`'s
`readAppVersion()` reads it out of `src/client/sw.js`'s own `CACHE_NAME`
(`"icom-rig-pwa-shell-v62"` -> `"62"`), falling back to `package.json`'s
`version` field only if `sw.js` can't be read or doesn't match the
expected shape. This was originally read straight from `package.json`
instead, on the theory that a single `require()` "could never drift out
of sync" — but nothing was ever bumping `package.json`'s version either,
so the on-screen number sat frozen at "v0.1.0" indefinitely while
`CACHE_NAME` (the number docs/pwa-notes.md actually requires bumping on
every client change, to bust the service worker's shell cache) kept
moving underneath it. Deriving the displayed version from `CACHE_NAME`
instead means there's exactly one version number to remember to update,
and the on-screen figure is a truthful readout of the shell cache that's
actually in effect. It's then passed through as `ControlServer`'s
`appVersion` option, cached in `this.state.appVersion` exactly like
`screenTitle`. Client-side, `index.html` wraps the `<h1>` title and a new
`<span id="app-version">` in a `.panel__title-group` flex container (so
the version sits directly next to the title rather than being pushed to
the opposite end of the header by `.panel__header`'s
`justify-content: space-between`); `app.js`'s `'connected'` handler sets
its text to `v${data.appVersion}` (or clears it if unset — e.g. a test
harness that constructs a `ControlServer` without passing `appVersion`).
`.app-version` in `styles.css` reuses `.led`'s `font-size: 0.8rem` /
`--text-muted` color so it visually matches the "Connected"/
"Connecting…" led text, per the request's explicit sizing instruction,
without literally sharing a CSS class with `#led-text` (that element also
carries mono font + flex layout that don't apply to inline text next to a
heading).

## Frequency/mode are primed at server startup, not left blank until first use

`ControlServer.state.frequency`/`state.mode` started out as `null` in the
constructor and only ever got populated reactively — a client's own
`GET_FREQUENCY`/`SET_FREQUENCY` (or `GET_MODE`/`SET_MODE`) request, or an
unsolicited CI-V "transceive" update from the radio itself. Since the
initial `'connected'` snapshot sent to a newly-connected client is just
`{...this.state}` (see "Screen title" above for the same mechanism), the
very first browser tab to open after the server started saw a blank
frequency display and no mode selected — right up until something
happened to trigger one of those requests, which nothing did on its own.

`listen()` now does an explicit best-effort read from the radio,
`civ.getFrequency()`/`civ.getMode()`, and stores the result into
`this.state` before it starts accepting connections — so the first
client's `'connected'` snapshot already has real values, the same as any
later client would get. This is deliberately best-effort: the reads are
guarded (a driver that doesn't implement one of these methods at all —
as some of this project's own test stub drivers don't — is skipped
rather than crashing `listen()`) and failures are swallowed with
`.catch(() => {})`, so a radio that isn't powered on yet, or a cable
that's unplugged, doesn't stop the server from starting; it just leaves
`state.frequency`/`state.mode` `null` as before, and the display stays
blank until the radio does respond to something.

## FT8/FreeDV "armed" state is also reflected in the initial snapshot

`state.ft8Active`/`state.freeDvActive` are a further instance of the same
gap "Frequency/mode are primed at server startup" above describes, but
for a different reason: frequency/mode were blank on the very first
client only, before anything had ever set them; FT8/FreeDV's armed state
could be blank on **every** newly-connecting client, indefinitely, even
while genuinely active — because unlike frequency/mode, there's no CI-V
"transceive" broadcast that could ever populate it (FT8/FreeDV are purely
app-level concepts layered on top of the radio's real USB/DATA-MODE
state, not anything the radio itself knows about or reports — see the
"FT8/FT4" and "FreeDV mode" sections below). `REQUEST.SET_FT8_ACTIVE`/
`REQUEST.SET_FREEDV_ACTIVE`'s handlers originally only `emit()`ted an
internal event for `Ft8Bridge`/`RadeBridge` to act on and acked the
requesting client — an explicit design comment even called this out as
deliberate ("armed state isn't synced"). In practice this meant: arm FT8
from one browser tab, open a second tab (or reload the first), and the
second connection's UI showed no indication FT8 was running at all, even
though decoding genuinely was — the exact bug report that prompted this
section.

The fix mirrors "Frequency/mode are primed at server startup" above:
`state.ft8Active`/`state.freeDvActive` are now set alongside the existing
`emit()` call in each handler, so they're part of `{...this.state}` in
every subsequent client's initial `'connected'` snapshot, the same
mechanism `ft8Variant`/`freeDvVariant` already used. **Deliberately not
broadcast to other already-connected clients on change** — unlike
`ft8Variant`, which *is* broadcast — since the original request was
specifically about detection on connect, and broadcasting a live toggle
to other clients is a different, larger feature (should another client's
UI update mid-session, possibly retuning/interrupting whatever that
operator is doing? unclear, and not what was asked for). The client side
(`app.js`) reads these two new snapshot fields and calls new
`reflectFt8ActiveFromServer()`/`reflectFreeDvActiveFromServer()`
functions — deliberately *not* `enterFt8Mode()`/`enterFreeDvMode()`
themselves, which would re-send `setMode`/`setDataMode`/
`setFt8Active`/`setFreeDvActive` requests and, for FT8, auto-tune to a
calling frequency — all of which already happened whenever the mode was
actually armed, and none of which should happen again just because a
second tab opened. The two new functions do only the local chip-highlight
and panel-visibility bookkeeping `enterFt8Mode()`/`enterFreeDvMode()` also
do, reading `currentFreqHz`/`ft8Variant`/`freeDvVariant` which are already
set from earlier in the same `'connected'` handler by the time these run.

## Gesture requirements (browser autoplay policy)

Both `AudioPipeline.enableSpeaker()` and `startTransmitting()` must be
called from within a user gesture handler (click/pointerdown), not
automatically on page load or on a WebSocket event — browsers block
`AudioContext` creation/resume and `getUserMedia` prompts outside a
gesture. The speaker button and PTT button both satisfy this by
construction; don't wire either to auto-trigger.

## Mic lifecycle

The mic stream (`getUserMedia`) is requested once, on first PTT press,
and kept alive across subsequent PTT presses — only the `transmitting`
flag toggles, gating whether captured frames actually get sent. This
avoids a repeated permission-adjacent delay and audio-graph
rebuild on every press, at the cost of the browser's "microphone in use"
indicator staying lit between transmissions rather than only during them.
Standard trade-off for push-to-talk style apps; `AudioPipeline.releaseMic()`
exists if a future "fully release mic" affordance is wanted.

## Screen Wake Lock

`app.js` requests a Screen Wake Lock (`navigator.wakeLock.request('screen')`)
as soon as the page loads, unconditionally — not gated on the WebSocket
being connected, PTT, or anything else — so the phone's own screen
timeout doesn't cut an operator off mid-QSO while they're just watching
the waterfall or listening to RX audio rather than actively touching the
screen. Feature-detected the same way as the service worker registration
just above it in the file (`'wakeLock' in navigator`), and just as
non-fatal to skip: this is a convenience, not a functional requirement,
and it's also a secure-context-gated API (see `docs/pwa-notes.md`), so it
silently does nothing over plain `http://<lan-ip>`.

**The lock doesn't survive the page being hidden, and re-acquiring it is
on us.** Per spec, the browser force-releases a Wake Lock the moment the
page's visibility state goes to `hidden` — switching tabs, locking the
phone's screen, backgrounding the browser app — and does **not**
automatically restore it when the page becomes visible again; a fresh
`request()` call is required every time. A `visibilitychange` listener
handles this: whenever the page becomes visible again and nothing is
currently held (`!wakeLock`), it requests a new one. The lock object's
own `'release'` event is what keeps `wakeLock` correctly nulled out
whenever the browser drops it out from under us (rather than only when
we explicitly release it — which this app currently never does; the lock
is meant to hold for as long as the page is open at all).

Not unit-tested — `navigator.wakeLock` needs a real browser (and in
practice a real device with a screen to actually observe the effect of),
consistent with this project's existing testing-boundary note for
anything that needs a live DOM/browser environment (see "Testing
boundary" below).

## FT8/FT4 (Phase 1 RX + Phase 2 manual TX, FT4 added later)

FT8 support is layered entirely on top of what already existed for CW —
same overall shape (a bridge attaching to `AudioBridge`'s RX stream only
when useful, pausing during our own TX), same "no CI-V primitive for
this" honesty — but with two genuinely new pieces CW never needed:
slot-boundary-aligned buffering and actual synthesized-waveform TX. See
`src/audio/ft8-bridge.js`'s own doc comment for the full server-side
design; this section covers the client and the app-level "FT8 mode"
concept that ties it to the rig UI.

FT4 was added afterwards, by repurposing the same mode button and the
same server-side machinery — see "FT4: a second protocol, same button"
below for what's actually different between the two (short version:
slot length and calling frequencies; everything else — the encode/decode
option shapes, the DecodedMessage shape, the UI panel, the guided QSO
sequencer, PSK Reporter spotting — is identical, because `@e04/ft8ts`
exposes `encodeFT4`/`decodeFT4` as drop-in siblings of
`encodeFT8`/`decodeFT8`).

### FT8 isn't a CI-V mode

The IC-7300 (like every Icom rig) has no "FT8" value in its CI-V mode
set — `src/civ/commands.js MODE` is exactly `LSB/USB/AM/CW/RTTY/FM`, and
that's genuinely all the radio understands. Real FT8 operation is just
USB with the actual mode-shaping happening entirely in software (the
encoder/decoder), which is exactly what this app does: selecting "FT8"
in the UI calls the ordinary `setMode` request with `mode: 'USB'`, then
separately arms the server's `Ft8Bridge` via a new `setFt8Active`
request. `ft8Active` is tracked as its own client-side boolean,
independent of the real hardware mode — so "is FT8 active" and "what
mode is the radio actually in" are two different, both meaningful,
questions, even though the FT8 chip is rendered from the same
`MODE_CHIPS` loop as the real mode chips (same class, same
`chip--active` highlighting) and sits in RTTY's old grid slot — RTTY is
still a real, supported hardware mode (`MODES` in `app.js`), it just no
longer has its own chip in the UI, at the user's request. The FT8 chip's
active state is tracked and toggled independently of `modeButtons`
(which only tracks the real hardware-mode chips), so it highlights
correctly regardless of what the underlying radio mode actually is.

Consequence: there's no way for the app to detect "the operator is doing
FT8" from CI-V alone (unlike CW, which self-activates purely from
`mode === 'CW'`). Exiting FT8 mode is therefore also explicit — clicking
any real mode chip calls `exitFt8Mode()` before requesting that mode,
rather than trying to infer intent from the resulting hardware mode
(picking USB itself doesn't mean "leave FT8", so an equality check
against the resulting mode wouldn't be reliable either way).

### Auto-tuning to the band's FT8 calling frequency

`FT8_FREQUENCIES` (in `app.js`) is the standard, widely-used FT8
dial-frequency-per-band convention (the same defaults WSJT-X ships) —
not something CI-V or this radio defines. Two things trigger a re-tune
to the current band's entry in that table:

1. **Entering FT8 mode** (`enterFt8Mode()`) — tunes immediately based on
   whichever band the current frequency falls into.
2. **A band change while FT8 is already active** — covered two ways:
   clicking a Band chip while `ft8Active` is true goes straight to
   `tuneFt8ToBand()` instead of that chip's normal quick-tune point (see
   the Bands click handler), and a **manual** frequency change (typed
   into the frequency field, a scope click, or an unsolicited change
   e.g. from the radio's own front panel) is caught by
   `checkFt8BandChange()`, called from `updateFrequencyDisplay()` on
   every frequency update while FT8 is active. Both paths funnel into
   the same `tuneFt8ToBand()`, which records the newly-targeted band
   into `ft8LastBandName` *before* its own `setFrequency` request
   resolves — so the frequency-changed callback that request itself
   triggers sees "already on the target band" and doesn't loop.

Band membership for the "did the band actually change" check uses
`BAND_RANGES`, a set of approximate amateur-band edges — deliberately
generous, since this only needs to pick the right FT8 calling frequency,
not police band-plan compliance (there's no regulatory content in this
table; it exists purely to answer "which of the ten `FT8_FREQUENCIES`
entries applies right now"). Both `tuneFt8ToBand()` and
`checkFt8BandChange()` now read the active protocol's table via
`ft8FrequencyTable()` rather than `FT8_FREQUENCIES` directly — see the
next section.

### FT4: a second protocol, same button

Added on top of the above, per an explicit request to add FT4 support by
**repurposing** the existing FT8 mode chip into a toggle, rather than
adding a second chip:

- **The button now has two states.** A click while inactive still enters
  FT8/FT4 mode exactly as before (`enterFt8Mode()`, unchanged); a click
  while *already* active calls the new `toggleFt8Variant()` instead,
  which flips `ft8Variant` between `'FT8'` and `'FT4'`, relabels the chip
  itself to show whichever is now active (its `textContent` just *is*
  `ft8Variant` — no separate indicator), and tells the server via a new
  `setFt8Variant` request (`REQUEST.SET_FT8_VARIANT` /
  `EVENT.FT8_VARIANT` in `protocol.js`), mirroring the existing
  `setPskSpotEnabled`/`psk-spot-enabled` request+event+state pattern
  exactly (state field `ft8Variant` in `ws-server.js`, defaulting to
  `'FT8'`; a `ft8-variant` internal event `Ft8Bridge` listens for; a
  broadcast so every other connected client's chip label stays in sync,
  the same "broadcast, don't assume" rule as every other toggle in this
  app).
- **FT8 and FT4 do NOT share calling frequencies.** `FT4_FREQUENCIES` (in
  `app.js`, alongside `FT8_FREQUENCIES`) is FT4's own standard
  band-plan convention — verified against multiple independent
  band-plan references (WSJT-X's own shipped defaults, cross-checked
  across three separate published frequency tables), not guessed or
  derived from FT8's table by some fixed offset. 160m is deliberately
  left out of `FT4_FREQUENCIES`: every source checked either omits it
  entirely or explicitly marks it "not designated" (no widely-adopted
  standard FT4 calling frequency exists for 160m at all) — entering FT4
  mode on 160m simply doesn't auto-tune, the same graceful no-op
  `tuneFt8ToBand()`/`checkFt8BandChange()` already have for any band
  missing from a frequency table, rather than tuning to a fabricated
  number. `tuneFt8ToBand()`/`checkFt8BandChange()` pick the right table
  via a small `ft8FrequencyTable()` helper keyed on `ft8Variant`, so
  every existing auto-tune trigger (entering FT8/FT4 mode, a Band chip
  click, a manual/scope-click/radio-side frequency change) automatically
  retunes to the *correct* protocol's frequency with no separate
  FT4-specific wiring needed. `toggleFt8Variant()` itself also
  immediately re-tunes to the new protocol's frequency for whatever band
  is currently active (not just on the next incidental band-change
  check), since "have it set the standard frequency for either protocol"
  was the explicit point of the toggle.
- **Toggling resets in-progress guided-QSO state.** FT8 (15s slots) and
  FT4 (7.5s slots) have incompatible slot timing, so a QSO step or
  decoded-message row left over from the protocol just switched away
  from has no meaning under the new one; `toggleFt8Variant()` clears the
  band-activity table (`ft8TableBodyEl.innerHTML = ''`) and resets the
  guided sequencer (`ft8Qso.reset()`) the same way leaving FT8 mode
  entirely already did (see `setFt8UiVisible(false)`), but *without*
  hiding the FT8 panel itself — the operator stays in FT8/FT4 mode
  throughout, just watching the panel start fresh under the new
  protocol.
- **Server-side**, `Ft8Bridge#setVariant()` (in `ft8-bridge.js`) is the
  single choke point: it re-grids `SlotClock` to the new protocol's slot
  length via the also-new `SlotClock#setSlotMs()` (which re-arms
  immediately against the new UTC grid rather than waiting out whatever
  was left of the old one — a switch mid-FT8-slot shouldn't have to wait
  up to 15s to take effect), discards RX audio buffered against the old
  grid (`this._rxChunks = []` — it can't be decoded as a slot of the
  *new* length), and rejects (rather than silently re-sending under the
  new protocol) any transmission that was merely *scheduled* for the
  next boundary but hadn't gone out yet. Encode/decode functions are
  looked up per-protocol (`this._encodeFns.FT8`/`this._encodeFns.FT4`,
  both defaulting to `@e04/ft8ts`'s `encodeFT8`/`encodeFT4`; the decode
  worker gets a new `protocol` field on every `'decode'` message and
  branches between `decodeFT8`/`decodeFT4` accordingly), and PSK
  Reporter spots now carry `mode: this._protocol` instead of a
  hardcoded `'FT8'`, so a station worked on FT4 is correctly reported to
  pskreporter.info as FT4, not FT8.
- **What's identical between the two protocols** (and so needed zero
  FT4-specific code): the sample rate (12000Hz for both), the
  encode/decode option shapes and the `DecodedMessage` shape
  (`@e04/ft8ts`'s FT4 exports are deliberately drop-in-compatible with
  its FT8 ones), the audio-domain FFT spectrum display, the FT8 panel's
  DOM/table/composer, the guided QSO sequencer's message-format parsing
  (`ft8-qso.js` — FT4 uses the same message grammar as FT8), and the
  `HashCallBook` cross-slot-callsign-resolution mechanism.

### Real bug found: entering FT8 mode never actually gave the radio an audio path to transmit on

`enterFt8Mode()` originally only ever called `setMode('USB')` before this
was found — see `docs/civ-notes.md`'s "DATA MODE" section for the full
story (CI-V byte layout, sourcing, and the one thing this fix still can't
do on its own). The short version: `USB` is only the *operating* mode:
the IC-7300 keeps a separate **DATA MODE** toggle whose own "MOD Input"
menu setting decides where TX audio actually comes from, tracked
independently from plain USB voice mode's. Without turning DATA MODE on,
the radio very likely stayed on whatever DATA-OFF MOD Input is configured
to (typically the front-panel mic) no matter what this app wrote to the
USB audio codec — PTT still keys, a transmission-shaped delay still
elapses, but nothing this app actually generates reaches the air. This
was found in response to a user reporting RX working perfectly but zero
successful QSOs, after the separate FT8-TX-timing bug (see above) had
already been fixed and hadn't resolved it — a strong sign the remaining
problem was upstream of timing altogether: no audio path, not bad timing
on a real one.

`enterFt8Mode()`/`exitFt8Mode()` now also call the new `setDataMode(true)`/
`setDataMode(false)` request (`CivDriver#setDataMode()`,
`src/civ/driver.js`) alongside the existing `setMode('USB')` call, turning
DATA MODE on for the duration of FT8 mode and back off when leaving it (so
whatever hardware mode is picked next gets its own expected MOD Input
back, typically the mic). **This alone is not guaranteed to be sufficient
on any given radio** — CI-V can turn DATA MODE on, but it cannot reach
into the radio's own menu and change what "MOD Input (DATA ON)" is
actually set to. See `docs/civ-notes.md` for exactly which menu screen to
check by hand if FT8 TX still isn't reaching the air after this fix.

**Update**: the first version of `setDataMode()` also had its own bug —
it sent the DATA MODE value as a single byte, but a real IC-7300 needs a
2-byte value field for this parameter. The command was silently accepted
(no error) but never actually took effect. See `docs/civ-notes.md`'s
"Real hardware confirms the address — but corrects the value's byte
width" for the full trace (found via a user's own hardware diagnostic
run) and the fix.

**Update**: `enterFreeDvMode()` had its sideband wrong: it always set
`mode: 'USB'`, correct only when FreeDV happens to be running at or above
10MHz. Standard amateur SSB *voice* convention is LSB below 10MHz
(160m/80m/40m) and USB at/above (30m and up) — this applies to FreeDV
exactly as it does to voice, since (as far as the radio's concerned)
FreeDV *is* just voice-shaped audio riding on an SSB signal (see "FreeDV
mode" below). `app.js` now has a `sidebandForFrequency(hz)` helper (LSB
below `10_000_000`, USB at/above) that `enterFreeDvMode()` uses instead
of the hardcoded `'USB'`, based on wherever the radio currently is (there
being no calling-frequency table to auto-tune FreeDV from).

**This first version of the fix over-applied the same rule to FT8/FT4**,
which was wrong the other way: FT8/FT4 are NOT operated per the SSB
LSB/USB-by-frequency convention at all — by long-standing convention
among WSJT-X-style digital modes, they're always run on USB regardless of
band, including on 160m/80m/40m where voice SSB would normally be LSB, so
that a given audio-frequency offset within the passband means the same
RF frequency on every band. `enterFt8Mode()` and `tuneFt8ToBand()` (the
latter shared by band chips and `checkFt8BandChange()`) were briefly
changed to call `sidebandForFrequency()` too; this has been reverted —
FT8/FT4 unconditionally set `mode: 'USB'` again, and `tuneFt8ToBand()`
goes back to only touching frequency, never mode.

Never verified against a real 80m/40m FreeDV QSO or FT8/FT4 session on
those bands from this environment (no radio here) — these are
straightforward, well-established conventions, not something that needed
hardware to validate the logic, but the usual caveats about anything
CI-V/radio-facing in this project still apply.

**Update**: the sideband fix above only ran at the moment a mode was
explicitly selected (or when FT8 auto-tuned, or FreeDV was armed) — it
didn't re-run on a plain band change while already sitting in LSB/USB.
Clicking a band chip while on, say, 40m LSB and landing on 20m left the
radio in LSB on 20m, which is wrong. `app.js` now tracks the radio's
current mode in a module-level `currentMode` variable, kept in sync by
`updateModeButtons(mode)` — the one function every mode-setting code path
already funnels through (the mode-chip click handler, the `'mode'`
broadcast listener, the initial `'connected'` snapshot, and FT8/FreeDV's
own sideband-setting code). The band-chip click handler now checks, after
a successful `setFrequency`, whether `currentMode` is `'LSB'` or `'USB'`
and, if so, re-derives the correct sideband for the new band via
`sidebandForFrequency()` and issues a `setMode` request if it differs.
This covers plain hardware SSB and FreeDV the same way, since FreeDV
already leaves the radio in LSB/USB via its own `updateModeButtons()`
call. FT8/FT4 band changes are unaffected — they go through
`tuneFt8ToBand()` instead, which (per the note above) deliberately never
touches mode.

### UI adaptation while FT8 is active (`setFt8UiVisible()`)

Per the explicit request to strip out controls that don't apply to FT8:

- The **PTT section** (push-to-talk button, hint text, and the CW
  paddle) is hidden outright — FT8 TX is server-driven (`Ft8Bridge`
  keys PTT itself at the next slot boundary once a message is queued),
  so a manual PTT button would be actively misleading here, not just
  unnecessary.
- The **Filter (bandwidth) control** is hidden — FT8's tone spacing and
  occupied bandwidth are fixed by the mode itself, not something the
  radio's IF filter selection meaningfully changes for decoding purposes
  in the way it does for voice/CW.
- The **scope span slider** is hidden, and the RF sweep display
  (`scope-line` events) is replaced entirely by a genuine audio-domain
  FFT spectrum of the RX audio, matching WSJT-X's own FT8
  spectrum/waterfall exactly rather than approximating it by cropping
  the radio's coarse CI-V sweep (an earlier version of this feature did
  exactly that, and was replaced once it became clear a real FFT was
  both more accurate and directly buildable from audio this app was
  already resampling for FT8 decoding — see git history for that
  now-removed `computeZoomedRange()`/`FT8_SCOPE_ZOOM` approach if
  useful background).

  The pipeline, end to end:
  1. **Server (`Ft8Bridge`, `src/audio/ft8-bridge.js`)** keeps a small
     rolling buffer of the same native-rate RX PCM it already receives
     from `AudioBridge` for decoding (independent of the slot-boundary
     -aligned decode buffer, since the spectrum needs to update far more
     often than once per 15s slot). On a timer
     (`FT8_SPECTRUM_INTERVAL_MS`, 250ms — "a few times per second", per
     the confirmed UX choice), `_emitSpectrum()` downsamples the most
     recent audio to `FT8_SAMPLE_RATE` (12kHz, the same rate used for
     decoding) via the existing `downsamplePcmToFloat()`, runs it
     through `computeMagnitudeSpectrum()` (`src/audio/fft.js` — a small
     from-scratch radix-2 FFT with Hann windowing; see that file's own
     doc comment and `test/fft.test.js`) with `FT8_SPECTRUM_FFT_SIZE`
     (4096) — chosen because it divides the 12kHz rate into exactly
     2.9296875Hz-wide bins, and 3000Hz (`FT8_SPECTRUM_MAX_HZ`) is
     *exactly* 1024 of those bins, so the passband cutoff lands cleanly
     on a bin boundary rather than an approximation. The result is
     cropped to those 1024 bins (0-3000Hz — FT8 only ever occupies audio
     from the dial frequency upward, never below) and converted to a
     0-255 byte per bin (`_dbToScaledBytes()`) for reuse with the
     client's existing `amplitudeToColor()` waterfall heatmap, then
     broadcast as a `BINARY_TYPE.FT8_SPECTRUM` binary frame
     (`encodeFt8SpectrumFrame()` — 1-byte tag + binHz as a little-endian
     float32 + one byte per bin, mirroring `ScopeBridge`'s own
     `encodeScopeLine()` header+payload pattern; see `protocol.js`'s doc
     comment for the full wire format).

     `_dbToScaledBytes()`'s scaling deliberately isn't a per-frame
     min/max stretch — an earlier version did exactly that, and it was a
     real bug: forcing whichever bin happened to be the single loudest
     *in that frame* up to pure red (and the quietest down to pure
     black) makes a frame of pure noise look identical to one with a
     genuine strong signal, since ordinary bin-to-bin noise variance
     alone spans a wide enough dB range to fill the whole color scale
     once stretched. This was caught from a user-supplied reference
     screenshot showing an almost solid-red waterfall alongside a batch
     of real decodes with SNRs of only -6 to -17dB (weak-to-moderate
     signals, not something that should paint the whole display red).
     The fix: estimate the noise floor as the per-frame *median* dB
     across all bins (robust to the handful of bins an actual FT8 tone
     occupies — each is only ~6.25Hz wide, at most a couple of these
     ~2.93Hz bins — even with several signals decoding at once), then
     map dB *above that floor* to the byte scale using a **fixed** span
     (`FT8_SPECTRUM_DYNAMIC_RANGE_DB`, 50dB) rather than the frame's own
     range. The floor still adapts per frame (so RX gain/band-noise
     changes re-center the display rather than clipping it), but the
     span that reaches full red no longer does — so an ordinary noisy
     frame now stays mostly blue/black, and only bins genuinely well
     above the noise floor read as green/yellow/red. The 50dB figure is
     a considered estimate, not a hardware calibration (there's no
     S-meter-style ground truth for "dB" in this audio-FFT context): it
     accounts for a single ~2.93Hz FFT bin reading roughly 29dB "hotter"
     than WSJT-X's own reported SNR (which is normalized to a 2500Hz
     reference bandwidth), so that WSJT-X-typical decode SNRs land
     somewhere around the middle of the scale rather than pinned to one
     end. See `_dbToScaledBytes()`'s own doc comment in `ft8-bridge.js`
     for the full reasoning, and `test/ft8-bridge.test.js` for the
     regression coverage (a uniform/noise-only frame must map to
     all-zero bytes, a fixed dB-above-floor must map to a fixed byte
     regardless of what else is in the frame, and the floor must stay
     anchored to the noise even with several strong signals present).
  2. **Client (`rpc.js`)** decodes that frame (`decodeFt8Spectrum()`)
     into `{ binHz, bins }` and dispatches it as an `'ft8-spectrum'`
     event, the same way `decodeScopeLine()`/`'scope-line'` already work
     for the RF sweep.
  3. **Client (`app.js`)** gates the two data sources on `ft8Active`: the
     existing `'scope-line'` listener no-ops while FT8 is active, and a
     new `'ft8-spectrum'` listener (active only then) calls
     `scopeDisplay.pushAudioSpectrum({ binHz, bins })`.
  4. **`ScopeDisplay#pushAudioSpectrum()`** (`scope.js`) draws the byte
     array as a trace/waterfall exactly like `pushLine()` does for RF
     data (same canvas, same `amplitudeToColor()` heatmap), but sets an
     internal `_audioMode` flag so click-to-tune is disabled (an
     audio-Hz x-axis position has no RF-frequency meaning) and reports
     its range as `{ lo: 0, hi: binHz * bins.length, audio: true }`. The
     `onRangeUpdate` callback in `app.js` checks that `audio` flag and
     formats the range/axis labels in whole Hz instead of `x.xxx MHz`,
     and skips `updateSpanSliderFromRange()` (meaningless for an
     audio-domain display).

  This needs no hardware span at all — the RF scope isn't even queried
  while FT8 is active — and gives genuinely better resolution than the
  RF-crop approach ever could, since it's a purpose-computed FFT of the
  actual demodulated audio rather than a slice of the radio's own
  general-purpose sweep. Leaving FT8 mode simply lets the existing
  `'scope-line'` listener resume driving `pushLine()` as before; no
  span/zoom state needs restoring since none was changed.
- In their place, the **FT8 panel** (`#ft8-panel`) appears: a
  band-activity table (one row per decode from the most recent
  completed slot, from the `ft8-decodes` broadcast, sorted strongest
  SNR first), a guided-QSO progress line (`#ft8-qso-status`, see below),
  and a manual composer (a text field + Send button, driving `sendFt8`).
  Clicking a decoded row that the guided sequencer recognizes (a CQ, or a
  reply to our own CQ) engages it via the guided sequence described
  below; anything else falls back to the original behavior of copying
  its message text into the composer as a plain starting point for a
  free-typed reply.
- Preamp/NR/NB/Notch and the RX gain slider are deliberately **not**
  hidden — they still meaningfully affect FT8 decode SNR the same way
  they affect any other weak-signal reception, unlike Filter/PTT/span.

### Guided FT8 QSO sequence (`src/client/ft8-qso.js`)

The FT8 composer originally only ever copied a clicked row's raw text in
verbatim — not an automatic reply builder, since the app had no concept
of the operator's own callsign/grid to build a reply from, and this was
an explicit open question left for later. Two things closed that gap:
configuring the operator's own station identity (`STATION_CALLSIGN`/
`STATION_GRID`, read server-side — see `src/server/index.js` and the
"Screen title" section above for the identical static-for-the-process
-lifetime pattern this reuses), and `ft8-qso.js`'s guided sequencer,
which now drives the standard FT8 exchange step by step as it's actually
decoded.

**Still guidance, not automation** — the module's own doc comment leads
with this, and it's worth repeating here since it's the same regulatory
boundary as "What's still Phase 3" below: every suggestion this module
produces is *only ever placed in the composer*. Nothing is transmitted
until the operator reviews it and presses Send, exactly like any other
composer text. `Ft8QsoSequencer` never calls `sendFt8` itself and has no
reference to anything that could.

**The standard exchange it follows** (see the FT8 protocol's own
well-established message set — the same sequence WSJT-X guides an
operator through):

```
Caller role (we click/engage a CQ heard from someone else):
  Tx2 (us->them, our grid)  ->  Tx3 (them->us, signal report)  ->
  Tx4 (us->them, R+our report of them)  ->  Tx5 (them->us, RRR/RR73)  ->  [Tx6 73]

CQer role (we send our own CQ, someone answers):
  Tx1 (us->all, CQ)  ->  Tx2 (them->us, their grid)  ->
  Tx3 (us->them, our report of them)  ->  Tx4 (them->us, R+their report)  ->  Tx5 (us->them, RR73)
```

Both roles converge on the same idea: whichever side sent the standard
message a moment ago is now waiting for the other side's matching next
message, and `Ft8QsoSequencer` only ever advances its tracked state in
response to something *actually decoded* — never merely because a
suggested reply happened to sit in the composer. That keeps "what are we
waiting for next" always grounded in what was genuinely heard, immune to
an operator ignoring a suggestion, editing it, or sending something else
entirely (the state machine just keeps waiting for the real thing).

**Two entry points**, both ending up in the same state machine:

1. **Clicking a decoded CQ** (`ft8Qso.engage()`) — starts the QSO in the
   **caller** role, immediately suggesting the Tx2 reply (`{THEIRCALL}
   {MYCALL} {MYGRID}`).
2. **Sending our own CQ** (`ft8Qso.noteOwnCqSent()`, called from
   `sendFt8Message()` in `app.js` when the just-sent text exactly matches
   `defaultCqMessage()`'s template) — arms "seeking" mode, watching every
   subsequent `ft8-decodes` slot for a reply addressed to us. `engage()`
   also supports manually picking a specific reply out of a pileup
   (clicking that row) rather than waiting for the automatic
   strongest-SNR pick `ingestDecodes()` makes on its own.

Deliberately *not* inferred from every `sendFt8` call — a manual,
free-typed transmission (anything that doesn't match the exact CQ
template) shouldn't silently arm a guided sequence the operator never
asked for.

**Frequency handling — "TX/RX frequency for the QSO in progress"**:
standard FT8 operating practice is to reply on the *same audio frequency*
the other station is actually listening on (their most recently decoded
frequency), not always your own fixed calling frequency — the same
convention WSJT-X's own "double-click a CQ" behavior follows. Since a
reply is heard by the other station only at the frequency they're
watching, "the TX frequency to reply at" and "the RX frequency to expect
their next transmission at" are the same single number throughout a
guided QSO, so this is tracked as one `freqHz` value per QSO rather than
two:

- It's captured from `decoded.freq` the moment a QSO starts (either from
  the clicked CQ's own decoded frequency, or the reply-to-our-CQ
  message's decoded frequency), and refreshed from every subsequent
  inbound message that advances the QSO — so it tracks the other
  station's own frequency drift automatically over the life of one QSO,
  the same "trust the latest real measurement over a stale assumption"
  approach already used for the CW decoder's auto pitch-calibration (see
  above) — a recurring theme in this app: never assume a configured or
  previously-observed value still holds when a fresher one is available.
- `applyFt8Suggestion()` in `app.js` is the one place a suggestion's
  `freqHz` gets applied: it's stored in `currentQsoFreqHz` (used as
  `sendFt8`'s optional `freqHz` — see `ws-server.js`'s `SEND_FT8` handler
  and `Ft8Bridge#send()`/`_transmitNow()`, which pass it through to the
  encoder as `baseFrequency`, overriding `txBaseFrequencyHz` for just
  that one transmission) and passed to `scopeDisplay.setQsoFreq()`, which
  draws a dashed amber marker on the FT8 audio spectrum at that
  frequency — the same drawing approach `_drawTuningMarker()` already
  uses for the RF tuning marker, just in the "active" amber color instead
  of green so the two are never visually confused (they never appear at
  the same time anyway — one is RF-mode-only, the other audio-mode-only).
- A plain/manual send (typing free text, or sending a fresh CQ) has no
  QSO frequency to target, so `currentQsoFreqHz` is `null` and `sendFt8`
  omits `freqHz` entirely — falling back to `Ft8Bridge`'s own
  `txBaseFrequencyHz` default, exactly as before this feature existed.

**Highlighting related messages**: `isRelatedToQso()` marks any decoded
message to, from, or CQing under the active QSO's partner callsign;
`app.js`'s `ft8-decodes` listener applies `.ft8-table__row--qso` (an
amber left-border, matching the spectrum marker's color) to those rows
before rendering each slot, so the operator can visually follow their own
exchange within a busy band-activity table without needing to read every
row's raw text.

**Completing/abandoning a QSO**: once the sequence reaches its final
step (`step === 'complete'`), the *next* time the operator sends anything
from the composer, `sendFt8Message()` resets the sequencer, clears the
frequency marker/status line, and refills the composer with a fresh
default CQ — ready for the next QSO without extra clicks. Leaving FT8
mode entirely (`setFt8UiVisible(false)`) also resets the sequencer
unconditionally — a stale partner/step from a previous session has no
meaning once RX decoding stops, and would otherwise silently appear to
resume "mid-QSO" the next time FT8 mode is entered. There's deliberately
no idle/no-reply timeout beyond that: if a QSO stalls (the other station
never answers), the operator can simply click a different CQ, which
starts a fresh QSO and abandons the stalled one — there's no need for the
module to guess when to give up on its own.

**Testing boundary**: `src/client/ft8-qso.js` is pure, dependency-free
logic (parsing + a state machine, no DOM) — fully unit-tested directly in
Node via `test/ft8-qso.test.mjs` (imported the same temporary-`.mjs`-copy
way `test/scope-display.test.mjs` handles this project's
CommonJS-`package.json`-vs-ESM-source split), covering message parsing,
`formatReport()`'s clamping, `defaultCqMessage()`, `isRelatedToQso()`,
and the full state machine end to end in both roles including pileup
handling. The DOM wiring in `app.js` (`applyFt8Suggestion()`, the row
highlight/click handling) needs a real browser to verify, the same
testing-boundary split already used for the rest of this app's UI code —
see "Testing boundary" at the end of this document.

### FT8 audio-spectrum hover tag + click-to-set-TX-frequency

The FT8 audio spectrum (see "UI adaptation while FT8 is active" above)
originally only displayed band activity — no interaction beyond the
band-activity table. Two additions close that gap, both in
`src/client/scope.js`'s `ScopeDisplay`, mirroring the RF scope's existing
hover-tooltip/click-to-tune UX exactly, but for the audio domain:

- **Hovering** the spectrum shows a pop-up tag with the audio frequency
  under the pointer, snapped to the nearest 50Hz (`snapTo50Hz()`) — e.g.
  "1500 Hz" — rather than the RF scope's kHz-snapped MHz reading
  (`snapToNearestKHz()`, "7.100 MHz"). 50Hz, not 1kHz: FT8 tones are
  packed only ~6.25Hz apart, and operators routinely pick a specific
  narrow slot within the passband to transmit in (e.g. "I'll go up on
  1500"), which a 1kHz snap would be far too coarse to express.
- **Clicking** the spectrum sets that 50Hz-snapped frequency as
  `currentQsoFreqHz` in `app.js` — the same variable the guided QSO
  sequencer's suggestions set — so the *next* FT8 transmission goes out
  on the frequency clicked, via the same optional `freqHz` on `sendFt8`
  already used for guided-QSO frequency targeting (see above). It's
  marked with the same amber dashed marker (`setQsoFreq()`/
  `_drawQsoMarker()`) already used to mark an in-progress guided QSO's
  frequency, per the explicit request that this be "indicated on the
  scope in the same way as for selected QSOs" — there's now exactly one
  visual language on the spectrum for "this is where the next
  transmission is going", whether that frequency came from clicking the
  spectrum directly or from engaging a decoded CQ.

Both behaviors are audio-mode-only, the same way click-to-tune/its hover
tooltip are RF-scope-only: `ScopeDisplay` tracks whichever mode last
pushed a frame (`pushLine()` vs. `pushAudioSpectrum()`) via `_audioMode`,
and the shared click/move handlers branch on it — clicking the RF scope
still retunes the VFO, clicking the FT8 spectrum never does (there's no
"RF frequency" a click there could sensibly mean), and vice versa for
which snap function and hover-tag format apply.

A manually-clicked frequency and the guided sequence's own tracking share
the one `currentQsoFreqHz` variable, so whichever set it most recently
wins — clicking a spot on the spectrum, then engaging a freshly-decoded
CQ, lets the CQ's own frequency (where that station is actually
listening) take over, which is the right behavior: a manual pick is a
starting point, not a commitment the guided sequence should be locked
into once a real QSO is under way.

### Default FT8 TX frequency (1500Hz) and its session-persisted override

A fresh CQ, or any other transmission with no more specific target (no
active guided QSO, no manual spectrum click yet), needs *some* frequency
to go out at. `DEFAULT_FT8_TX_FREQ_HZ` in `app.js` (1500Hz) is that
default — the conventional mid-passband value most FT8
operators/software (WSJT-X et al.) actually use, matching the server's
own `DEFAULT_TX_BASE_FREQUENCY_HZ` fallback in `src/audio/ft8-bridge.js`
(kept in sync deliberately, even though the client always sends an
explicit `freqHz` once FT8 mode is active, so the server-side value is
mostly a safety net rather than something actually relied on in normal
operation).

Per an explicit request that a manually-chosen TX frequency persist
rather than silently reverting, `app.js` separates "the default" from
"the operator's current default" — `ft8DefaultTxFreqHz`, a module-level
variable seeded from `DEFAULT_FT8_TX_FREQ_HZ` but updated (and *staying*
updated) whenever the operator clicks the FT8 audio spectrum (see the
hover/click feature above). Every place that previously fell back to
`currentQsoFreqHz = null` — entering FT8 mode, sending a fresh CQ, a
guided QSO wrapping up — now falls back to `ft8DefaultTxFreqHz` instead,
so:

- The amber TX-frequency marker is shown on the spectrum from the moment
  FT8 mode is entered, at whatever the session's current default is (not
  just once a QSO or a click sets one) — this is also what "set the
  waterfall marker to match" the default meant in practice: there's no
  separate "default marker" concept, the existing QSO-frequency marker
  simply always has *some* frequency to show now, rather than staying
  hidden until an operator action set one.
- Clicking a new frequency on the spectrum changes where the *next* CQ
  (and every fresh CQ after that, for the rest of the session) goes out,
  not just the one transmission immediately following the click.

**"Persisted" here means for the lifetime of the page load, in a plain
JS variable — the same scope every other piece of session-only UI state
in this file already uses (e.g. `stationCallsign`/`stationGrid`, fetched
once per connection).** It is explicitly *not* written to `localStorage`
or any server-side setting, and resets to 1500Hz on a page reload — this
app has no persistence layer for client-side preferences at all (nothing
else in `app.js` uses `localStorage` either), and adding one wasn't part
of what was asked; "within the session" was read literally.

### What's still Phase 3 (explicitly not built)

No **full** auto-sequencing (WSJT-X-style automatic QSO completion —
*deciding and sending* the next message without a human choosing each
transmission). This is a deliberate scope boundary, not a missing
feature: full auto-sequencing would be a materially stronger form of
"automatic control" than anything else in this app (including the CW
paddle, which still requires a human holding a button per element), and
that has real weight under supervised-operation provisions in amateur
licence conditions (the same regulatory caution already applied to the
PTT fail-safe watchdog — see `docs/civ-notes.md`). The guided QSO
sequence above narrows the gap considerably — every message the standard
exchange calls for is prefilled the moment it's decoded — but every
transmission in this app's FT8 support, guided or not, is still the
direct result of an operator reviewing composer text and pressing Send.

### Real bug found: FT8 transmissions were losing their tail to ALSA/pipe latency

A user reported not having completed a single successful FT8 QSO, and asked
two direct questions: is the correct audio sample actually being generated,
and will it be sent reliably in the correct time segment? These turned out
to have different answers.

**Sample generation: verified correct.** Direct, isolated testing confirmed
`encodeFT8()` produces a standard, fully-decodable 12.64s (151680-sample
@12kHz) waveform, and — more importantly — that this app's actual
12kHz-to-48kHz-to-12kHz resample round trip (`upsampleFloatToPcm()` on TX,
`downsamplePcmToFloat()` on RX, both in `src/audio/resample.js`) preserves
the message and decodes cleanly with a strong SNR when fed straight back
through `decodeFT8()`. The DSP pipeline itself is not the problem.

**Timing: a real bug.** `Ft8Bridge._transmitNow()` (`src/audio/ft8-bridge.js`)
keyed PTT, wrote the encoded PCM to `AlsaPlayback` (`src/audio/alsa.js`),
waited exactly the *nominal* PCM playback duration, then released PTT.
`AlsaPlayback.write()` only hands the buffer to the OS pipe feeding a
persistently-running `aplay` process — it returns as soon as the pipe
accepts the bytes, not once they've actually reached the speaker. Two
further delays sit between "write() returned" and "sound is actually
happening": `aplay` reading the pipe, and ALSA's own hardware ring buffer
(`buffer_time`/`period_time`, whatever the USB codec on the actual hardware
defaults to — see `docs/audio-notes.md`). Releasing PTT the instant the
nominal duration elapsed meant the radio was very likely being de-keyed
before the last chunk of audio had physically gone out, truncating the tail
of *every* FT8 transmission. For a 79-symbol LDPC-coded FT8 message, losing
even the last symbol or two at the receiving station is enough to prevent a
clean decode — this is a fully plausible explanation for zero completed
QSOs despite a verified-correct waveform.

The fix: `_transmitNow()` now waits `durationMs + PTT_RELEASE_MARGIN_MS`
before releasing PTT, where `PTT_RELEASE_MARGIN_MS` (300ms, exported from
`ft8-bridge.js`, and injectable as `opts.pttReleaseMarginMs` on the
`Ft8Bridge` constructor for testing) is a deliberately generous margin —
comfortably larger than typical ALSA buffer/period sizes, with room for
Node event-loop/pipe scheduling jitter too. Since FT8's 15-second slot
structure has plenty of idle time before the next scheduled transmission,
erring high here costs nothing; the only real risk was ever erring low.
See the constant's doc comment in `src/audio/ft8-bridge.js` for the full
reasoning.

**What this doesn't (and can't) verify.** This fix addresses a genuine,
concretely-reasoned gap in the TX pipeline's own timing logic, but it can't
be the *only* possible explanation for failed real-world QSOs — this app
has no way to confirm the actual ALSA `buffer_time`/`period_time` on the
specific hardware in use, audio levels/gain into the transceiver's DATA
input (the README already flags that USB audio levels reset to maximum on
every server start), or band/propagation conditions at the time of an
attempt. Those remain things only a real over-the-air test can confirm or
rule out — same caveat as the CW decoder's own real-audio verification
needed a real radio before it could be trusted.

### Testing boundary for FT8

Same split as the rest of the client (see "Testing boundary" above):
`src/audio/slot-clock.js`, `src/audio/resample.js`,
`src/audio/fft.js`, and `src/audio/ft8-bridge.js` are fully
unit/integration tested against injected fake timers/worker/audio
-bridge/control-server doubles (see `test/slot-clock.test.js`,
`test/resample.test.js`, `test/fft.test.js` (bin-width/peak-location
correctness for the FT8 spectrum FFT, including short-input zero
-padding and silent-input edge cases), and `test/ft8-bridge.test.js` —
the resampler tests include a real anti-aliasing regression, and the
bridge tests cover attach/detach around PTT, slot-boundary decode
requests, callsign-memory carry-over across slots, the TX
queue/replace/error paths, the PTT-release margin described above (by
intercepting the real `setTimeout` to assert the actual requested delay,
rather than waiting for it in real time), and the spectrum
timer/framing/autoscaling logic behind the FT8 audio-spectrum display
above, via an injected `computeSpectrumFn` stub, and — via an injected
`StubPskReporter` — that PSK Spot decodes are queued (or correctly
skipped) depending on the enabled flag and whether a station identity is
configured, with the right absolute frequency). `src/audio/psk-reporter.js`
itself has its own dedicated `test/psk-reporter.test.js` — see "PSK Spot
checkbox" above. The actual
`@e04/ft8ts` `decodeFT8`/`encodeFT8`/`decodeFT4`/`encodeFT4` calls and
the worker-thread plumbing that runs them are exercised indirectly (the
bridge's own tests inject a stub worker rather than spawning a real one)
rather than end-to-end — a genuine over-the-air FT8/FT4 decode/encode
round trip still needs manual verification against a real radio, the
same as the CW decoder's own real-audio verification was needed before
it was trusted. The FT8 panel's DOM/table/composer code has no automated
test, for the same reason the rest of the DOM-facing client code doesn't
(see "Testing boundary" above) — except the guided QSO sequencer's own
pure logic (`src/client/ft8-qso.js`), which is fully unit-tested in
`test/ft8-qso.test.mjs`; see "Guided FT8 QSO sequence" above for what
that covers.

**FT4/variant-switching coverage specifically:** `test/slot-clock.test.js`
covers `SlotClock#setSlotMs()` — rejecting a non-positive value,
updating `slotMs` while stopped (no timer to re-arm), and re-arming
immediately against the *new* grid while running (verified by firing a
fake scheduler forward and checking the boundary lands at the new grid's
next multiple, not the old grid's already-scheduled one), including
switching back and forth repeatedly. `test/ft8-bridge.test.js` covers
`Ft8Bridge#setVariant()` end to end via the same injected-doubles
approach as the rest of that file: the default protocol is `'FT8'`;
an unknown variant string throws; switching re-grids the injected
`StubSlotClock` (extended with a spied `setSlotMs()`) to
`FT4_SLOT_MS`/`FT8_SLOT_MS`; setting the already-active variant is a
no-op (no redundant re-grid); the internal `'ft8-variant'` event (the
`ws-server.js` request handler's path) drives the exact same code as
calling `setVariant()` directly; switching discards RX audio already
buffered under the old slot grid; switching rejects (rather than
silently carrying over) a transmission that was merely *scheduled* but
hadn't gone out yet; transmitting while in FT4 mode calls the injected
FT4-specific encode function (not the FT8 one); a decode request posted
to the worker while in FT4 mode is tagged `protocol: 'FT4'`; and a PSK
Reporter spot reported while in FT4 mode carries `mode: 'FT4'`, not a
hardcoded `'FT8'`. `test/ws-server.test.js` covers the
`setFt8Variant`/`EVENT.FT8_VARIANT` request itself — defaulting to
`'FT8'`, updating `state.ft8Variant` and acking with the applied value,
emitting the internal event, broadcasting to other connected clients,
and rejecting anything other than `"FT8"`/`"FT4"` — mirroring the
existing `setPskSpotEnabled` test block exactly. The decode worker's own
`protocol`-based branch (`decodeFT8` vs `decodeFT4` in
`ft8-decode-worker.js`) has no dedicated test file — consistent with the
FT8-only decode path never having had one either (see the paragraph
above); it's covered only indirectly, by the bridge tests asserting the
right `protocol` field is posted.

### "PSK Spot" checkbox: reporting decoded stations to pskreporter.info

A checkbox labeled **"PSK Spot"** sits directly below the Notch button
(the only `FUNCTION_CONTROLS` entry that stays visible during FT8 mode —
see "UI adaptation while FT8 is active" above), shown only while FT8 mode
is active, checked by default. While checked, every FT8 station this app
actually decodes gets reported to the real PSK Reporter propagation
-reporting service (pskreporter.info) — this is genuine, working
UDP-protocol spot reporting, not a cosmetic toggle with no effect,
consistent with how the rest of this app's FT8 support was built.

**Wire protocol.** PSK Reporter's protocol is IPFIX (RFC 5101/7011)
-based. The official developer page
(`pskreporter.info/pskdev.html`) only describes it in prose, with no
byte-level spec, so `src/audio/psk-reporter.js` was built instead by
reading a real, actively-used, open-source reference client in full —
WSJT-X/JTDX's own `PSK_Reporter` class (`psk_reporter.cpp`, GPL) — and
transcribing its packet-building logic field by field. See that module's
own doc comment for the full field/template layout (Rx Info template
`0x50E2`: call/grid/software/antenna; Tx Info template `0x50E3`:
call/frequency/SNR/mode/grid/info-source/time; enterprise number
`0x0000768F`).

**Batching and rate limits.** Per pskreporter.info's own stated limits,
this client sends at most once every 5 minutes (matching the reference
implementation's own cadence exactly), batching however many stations
were decoded since the last send into one UDP packet, and resends both
template descriptor sets with every packet (the reference's own
simplest-safe choice, well within the "at least once an hour" allowance).
Nothing is ever sent if nothing was decoded in that window.

**Frequency reported.** The "Tx Freq" field PSK Reporter's map actually
displays is the *absolute* frequency, not the ~1500Hz audio-domain offset
FT8 decodes carry internally (see "FT8 isn't a CI-V mode" above) — so
`Ft8Bridge#_reportSpots()` adds the radio's current dial frequency
(`ControlServer.state.frequency`, kept live by CI-V's own unsolicited
frequency updates) to each decode's `freq` field before spotting it.

**Which decodes get spotted.** `extractSpot()` pulls "who transmitted
this, and their grid if they sent one" out of each decoded message's raw
text — a deliberately simpler, server-side sibling of
`src/client/ft8-qso.js`'s `parseFt8Message()` (that one drives the much
richer guided-QSO state machine; this one only needs a callsign). A
decode is only spotted if its apparent "from" token passes a
callsign-shaped heuristic regex — this rejects the many non-callsign FT8
tokens (`RR73`, `RRR`, a bare signal report) but is not a strict
ITU-format validator, so an occasional edge-case callsign format could in
principle be missed (not spotted) or, in theory, a very unusual
non-callsign token could pass it; neither has been observed in testing.
One specific trap worth calling out: `RR73`'s own letters ("RR") fall
entirely inside the valid Maidenhead grid-square letter range (A-R), so
naively grid-matching it would misreport `RR73` itself as a locator —
`extractSpot()` (and `parseFt8Message()`, which already handled this)
explicitly excludes `RR73`/`RRR`/`73` from grid-matching first.

**Requires a configured station identity.** Spotting is a hard no-op
(nothing ever queued, nothing ever sent) unless `STATION_CALLSIGN` is
configured server-side — PSK Reporter has no meaning without knowing who
the receiving station is, and this app has no other source for that
identity (see "FT8 (Phase 1 RX + Phase 2 manual TX)" above). The PSK
Spot checkbox itself still shows/toggles normally either way; it simply
has nothing to report until STATION_CALLSIGN is set.

**Enable/disable is shared server state**, same pattern as `DATA_MODE`:
`REQUEST.SET_PSK_SPOT_ENABLED` / `EVENT.PSK_SPOT_ENABLED` in
`src/server/protocol.js`, `ControlServer.state.pskSpotEnabled` (default
`true`, included in the "connected" snapshot so a second browser tab
stays in sync), and an internal `'psk-spot-enabled'` event `Ft8Bridge`
listens for — the same internal-event pattern `SET_FT8_ACTIVE`/`ft8-active`
already uses, since `ControlServer` has no reference to `Ft8Bridge`
itself.

**What's verified vs. not.** The packet-encoding logic has been checked
byte-for-byte against the reference implementation's own hex-building
code (`test/psk-reporter.test.js` decodes a built packet field-by-field
and checks every value round-trips, including a negative SNR's signed
-byte encoding) and the callsign/grid extraction logic is unit-tested
against the standard FT8 message set (`extractSpot()`'s tests in the same
file). What is **not yet verified**: whether the real pskreporter.info
service actually accepts and displays a packet built by this code —
that service gives no error feedback at all for a malformed packet, it
simply never shows the spot, so the only way to confirm this end-to-end
is to check the configured `STATION_CALLSIGN` actually appears on
pskreporter.info's live map after a real FT8 decode with PSK Spot
enabled and a real station identity configured.

## FreeDV mode (RADE V1, real RADE codec bridge — see "The RADE codec bridge" below)

A third app-level pseudo-mode chip, added alongside FT8/FT4 at the user's
request and following the same interaction pattern: `MODE_CHIPS` in
`app.js` gets a `'FreeDV'` sentinel, rendered as an ordinary chip but
wired up specially in the mode-chip render loop, just like `'FT8'`. A
click arms FreeDV mode (`enterFreeDvMode()`), showing "RADE V1" while
active; a second click while already active is a no-op — unlike FT8/FT4,
there's no second variant to toggle to any more (see "700E was removed"
below).

**Neutral label while not selected.** The chip reverts to the
mode-neutral label "FreeDV" the moment FreeDV mode is left (picking any
other mode chip, or picking FT8, both call `exitFreeDvMode()`, per
"Mutual exclusivity with FT8" below). Without this, the chip would freeze
on "RADE V1" even while sitting on CW, which reads as "RADE is somehow
still active" rather than "click here to arm FreeDV." `updateFreeDvVariantUi()`
keys off `freeDvActive` to decide which label to show, and is called from
both `enterFreeDvMode()` and `exitFreeDvMode()`.

**700E was removed, per explicit request.** FreeDV originally offered a
second variant alongside RADE — 700E, the newest and most robust of
FreeDV's Codec2-based 700-series modes (better multipath/fading tolerance
than 700C/700D at the same ~700bps voice bitrate) — toggled by a second
click on this same chip, the same "one chip, two labels" pattern the
FT8/FT4 toggle still uses. It never had a working codec behind it in this
codebase (see "700E never had a codec" below, kept for the historical
record) — arming FreeDV while on that variant only ever got the radio
into the right operating mode and showed the label, nothing more — so it
was dropped from the UI entirely rather than kept as a non-functional
choice. RADE ("Radio Autoencoder") — a fundamentally different mode built
on a neural-network vocoder rather than Codec2, aiming for near-FM-quality
speech at HF SSB bandwidths — is now the only thing this chip ever means,
labeled "RADE V1" to name the specific waveform version (`RADE_VERSION`
defaults to `v1`; see "The RADE codec bridge" below) rather than leaving
it ambiguous now that there's no variant choice left to disambiguate from.
`toggleFreeDvVariant()` and the client-side `freeDvVariant` state
tracking it required are both gone; the server-side variant *mechanism*
(`controlServer.state.freeDvVariant`, `SET_FREEDV_VARIANT`,
`RadeBridge#setVariant()`) still technically exists and still accepts
`'700E'` (nothing currently enforces otherwise), now just permanently
defaulted to `'RADE'` and never switched by anything client-side — see
"The RADE codec bridge" below for why that default specifically had to
change alongside the UI removal, not just the UI.

**What entering FreeDV mode actually does — and why it's a much lighter
touch than FT8.** Both FT8 and FreeDV are voice/data content carried over
a plain SSB-shaped RF signal — the radio itself has no idea it's carrying
either one, which is exactly why neither needed its own CI-V mode value.
`enterFreeDvMode()`/`exitFreeDvMode()` reuse exactly the same mechanism
`enterFt8Mode()`/`exitFt8Mode()` already established: put the radio on
USB, and flip CI-V DATA MODE on/off so TX audio is sourced from the USB
audio interface rather than the front-panel mic (see "FT8" above for the
CI-V specifics — they're identical here). That's the entire scope of what
this chip does to the radio.

**700E never had a codec** (historical — the variant itself is gone, see
above). It was Codec2-based — forward error correction, OFDM/QPSK
modulation, all of it a completely different codebase from RADE.
Implementing a from-scratch 700E modem would have been a substantially
larger undertaking than either of the RTTY/CW decoders or even FT8's
encode/decode pipeline (`src/audio/ft8-bridge.js`, via `@e04/ft8ts`), and
wasn't part of what was asked for.

**RADE now has a real, working codec bridge — but not one built from
scratch here.** At the user's request, `src/server/rade-bridge.js` shells
out to the rade_c project's own compiled binaries
(github.com/freedv/rade_c — `radae_tx`, `radae_rx`, `lpcnet_demo`,
`real2iq`) rather than reimplementing RADE's neural-vocoder codec in this
project. See "The RADE codec bridge" below for the full pipeline, and its
own doc comment in rade-bridge.js for the fine detail this file
summarizes.

**Mutual exclusivity with FT8.** Since both chips do nothing more than
park the radio on USB + DATA MODE (the RADE codec bridge below changes
what's *encoded onto* that audio, not the CI-V state the radio sees),
clicking one while the other is active exits the other first
(`exitFt8Mode()`/`exitFreeDvMode()` calls in each chip's click handler)
rather than leaving both "active" with no meaningful distinction between
them.

## The RADE codec bridge

`src/server/rade-bridge.js` (`RadeBridge`) wires the compiled rade_c
binaries to the radio's actual RX/TX audio, active whenever the client's
FreeDV toggle is armed (`SET_FREEDV_ACTIVE`, mirroring FT8's own
`SET_FT8_ACTIVE`) *and* the active variant is `'RADE'`. Since the client
can no longer select any other variant (the '700E' UI toggle was removed —
see "FreeDV mode" above), both `RadeBridge`'s own constructor default and
`controlServer.state.freeDvVariant`'s default changed from `'700E'` to
`'RADE'` alongside that removal — leaving either one at the old `'700E'`
default would have silently broken RADE for anyone not on a stale client
version still capable of sending `setFreeDvVariant`, since there'd be no
way left to switch the bridge on at all. `'700E'` remains a
technically-valid value to write (`RadeBridge#setVariant()` still accepts
it, and it still leaves the bridge fully idle — no subprocess spawned at
all — exactly as before), it just isn't reachable from this app's own UI
any more.

**Installing the binaries.** See the "Installing rade_c's built binaries
and librade.so system-wide" guidance given directly to the user for this
feature — in short: `radae_tx`, `radae_rx`, and `lpcnet_demo` need to be
reachable on PATH (or pointed at via `RADE_TX_BIN`/`RADE_RX_BIN`/
`LPCNET_DEMO_BIN`, see src/server/index.js), and `librade.so`/
`librade.so.0.1` need to be somewhere the dynamic linker finds them
(`/usr/local/lib` + `ldconfig`, typically). rade_c's build also produces a
fourth tool, `real2iq`, but this bridge doesn't use it (see "Real bug
found: `real2iq` doesn't belong in a live pipeline at all" below) — no
harm in it being installed, there's just no env var pointing at it.
`RadeBridge` itself doesn't check any of this at startup — a missing/
broken binary just fails to spawn the first time RADE is actually armed,
reported as an `EVENT.AUDIO_ERROR` broadcast rather than crashing the
server.

**Why this needed two chained subprocesses per direction, not one.**
Neither `radae_tx` nor `radae_rx` speaks raw audio at all — `radae_tx`
reads Codec2-style *vocoder features* on stdin and writes complex-IQ
modem symbols to stdout; `radae_rx` is the mirror image, expecting
complex-IQ on stdin (`RADE_COMP`: two interleaved float32s per sample, per
`rade_api.h`). Extracting those features from real speech (TX) and
re-synthesizing speech from them (RX) is `lpcnet_demo`'s job. There is
**no dedicated streaming tool for turning a radio's real-valued audio into
the complex IQ `radae_rx`/`radae_tx` need**, on either direction — see
"Real bug found" below for the two wrong tools this project tried
(`real2iq`, and simply mis-scaling PCM) before landing on what rade_c's
own reference tool (`rade_demod_wav.c`) actually does: build the complex
IQ directly, in code, with the imaginary part set to zero. This bridge
does the RX-side equivalent in JS (`realFloatToZeroImagIq()` in
`rade-bridge.js`), and, symmetrically for TX, does in JS exactly what the
reference GUI client (peterbmarks/radae_decoder) does: takes the real (I)
component of `radae_tx`'s complex output directly, discards the
imaginary (Q) component, and applies an adjustable gain on top
(`RADE_TX_GAIN`) — see `extractRealFromComplexFloat32()` in
`rade-bridge.js`. So each direction is its own little pipeline, and they
are *not* mirror images of each other:

```
TX: mic audio (16kHz) -> lpcnet_demo -features -> radae_tx [--v2] -> (JS: take real part, apply RADE_TX_GAIN) -> modem audio (8kHz, real)
RX: modem audio (8kHz, real) -> (JS: int16 PCM -> zero-imaginary complex float32 IQ, scaled by RADE_INT16_SCALE) -> radae_rx [--v2] -> lpcnet_demo -fargan-synthesis -> speech audio (16kHz)
```

`--v2` is bracketed above because it's opt-in, not default — see "Genuinely
unverified" below for why this bridge defaults to RADE V1.

**The `RADE_INT16_SCALE` scaling convention — applied on RX, deliberately
not on TX.** `rade_api.h` documents a scaling constant, `RADE_INT16_SCALE`
(`16384.0`), for converting between `radae_tx`/`radae_rx`'s native float
domain and 16-bit PCM — and it is **not** the same as this codebase's
usual "int16 full-scale" PCM convention (divide/multiply by 32768). Per
that header's own comment block: TX packs `radae_tx`'s real output to
int16 via `* RADE_INT16_SCALE` (nominal float amplitude 1.0 -> int16
16384, deliberately only half of the int16 ceiling, leaving 6dB of
headroom for peaks); RX, for real-valued input specifically (an SSB radio
or a WAV file, as opposed to genuine complex IQ), unpacks int16 to float
via `* (2.0 / RADE_INT16_SCALE)` (int16 / 8192) — the factor of 2
compensates for `Re{}` halving the power of the positive-frequency
component `radae_rx`'s correlators are tuned to. This bridge applies the
RX half of that (confirmed working over the air), but **not** the TX
half — an on-air test showed the documented TX scale made this app's real
transmit chain too quiet; see "Real bug found: reverting the
`RADE_INT16_SCALE`-based TX scaling" below for the full story and why RX
and TX ended up treated differently despite the header documenting both
symmetrically. Missing the RX half and just using the generic 32768-based
PCM scale there doesn't crash anything — it just hands the neural
network/OFDM correlators a signal at the wrong amplitude, which (same as
the sample-format bugs below) looks indistinguishable from "nothing is
happening." See "Real bug found" below for how both the RX fix and the TX
revert were found.

`RadePipeline` (`src/audio/rade-pipeline.js`) is the generic plumbing for
this: spawns each stage, pipes `stdout` into the next stage's `stdin`,
re-emits the last stage's `stdout` as its own `'data'` event, and tears
the whole chain down together if any single stage exits unexpectedly.
`RadeBridge` doesn't otherwise care how many stages a direction needs —
it just builds the `stages` array for TX and RX once at attach time.

**Sample rates, and why resample.js's "downsample" function does both
directions.** RADE's own speech-domain rate (both the mic-audio side of
TX and the recovered-speech side of RX) is 16kHz; its modem/RF-domain
rate (both the transmitted waveform and the received audio `radae_rx`
expects) is 8kHz — fixed by the tools themselves (`RADE_FS_SPEECH`/
`RADE_FS` in the upstream C sources), not a choice made here. This app's
own audio pipeline runs at `AUDIO_SAMPLE_RATE` (48kHz by default), so
every hop through this bridge needs a resample in one direction or the
other. Rather than write a second resampler, `rade-bridge.js`'s
`resamplePcm()` helper reuses `resample.js`'s existing
`downsamplePcmToFloat()` — which, despite the name (written for FT8's
RX-only downsampling need), actually resamples in *either* direction: its
`toRate >= fromRate` branch skips the anti-aliasing filter and just
resamples, exactly what an upsample needs. See resample.js's own doc
comment for why the filter matters at all for the downsampling case.

**Muting AudioBridge's own passthrough.** Unlike CW/RTTY/FT8's RX
decoders — which only ever *observe* the shared capture stream, decoding
to text or leaving raw audio playing throughout — RADE decodes to
*audio*, which would otherwise collide with `AudioBridge`'s own always-on
raw RX broadcast and TX passthrough (raw modem tones and decoded speech
both hitting the client's speaker at once; the operator's raw mic audio
and this bridge's encoded audio both racing into `playback` at once). So
`AudioBridge` gained two small new methods, `setRxMuted()`/
`setTxMuted()` (see audio-bridge.js's own doc comment), which
`RadeBridge` calls for exactly as long as its RX/TX pipeline is attached.
Decoded RX speech is then broadcast on the *same* channel/tag
(`BINARY_TYPE.AUDIO`, via the newly-exported `tagAudio()` helper) the
raw audio would have used — the client needs zero code changes to hear
it, since from its point of view this is just another ordinary
`'audio-frame'` event.

**TX is driven by the operator's own PTT, not synthesized like FT8's.**
FT8 generates and transmits its own waveform on a schedule
(`Ft8Bridge#_transmitNow()`); RADE, being a voice codec, transmits
whatever the operator is actually saying into their mic while they hold
PTT down, same as any analog voice mode. So `RadeBridge` doesn't touch
PTT itself at all — it just gates which pipeline (RX or TX) is attached
on the existing shared `'ptt'` state, exactly the same `!pttActive`-style
gating CW/RTTY's decoders already use, just with the sense flipped for
the TX side too (RX attached while `!pttActive`, TX attached while
`pttActive`, both only while armed on the RADE variant — see
`_syncAttachment()`).

**Genuinely unverified — read this before relying on it.** Every other
decoder in this codebase was checked against either synthetic audio
generated and decoded in the same environment it was written in (CW,
RTTY — see those sections above), or a real encode/decode round-trip via
an actual JS library (FT8, via `@e04/ft8ts`). Neither is possible here:
`radae_tx`/`radae_rx`/`lpcnet_demo` are native binaries that
only exist on the operator's own server (compiled there from
github.com/freedv/rade_c, per the install guidance given directly to the
user), not in whatever environment this app's code itself gets written or
reviewed in. So while `RadeBridge`'s and `RadePipeline`'s own
orchestration logic is tested (`test/rade-bridge.test.js`,
`test/rade-pipeline.test.js` — subprocess spawning/piping/teardown,
mode/PTT gating, resampling glue, muting), none of the following have
been verified at all:

- That the actual argv/stdin-stdout conventions assumed here (`-features
  - -`, `-fargan-synthesis - -`, `--v2`, `radae_rx`/`radae_tx` reading/
  writing raw `RADE_COMP` complex float32 with no header or framing, and
  the `RADE_INT16_SCALE` scaling formulas) match the real compiled
  binaries — these were read from rade_c's own example shell pipelines,
  `lpcnet_demo.c`'s/`radae_rx.c`'s/`radae_tx.c`'s own argument parsing and
  I/O code, and `rade_api.h`'s own documented scaling comments, not
  exercised against a real build until the fixes described below
  (including the `real2iq` batch-tool and scaling bugs — see "Real bug
  found: `real2iq` doesn't belong in a live pipeline at all..." further
  down).
- That the assumed sample rates (16kHz speech, 8kHz modem) are correct
  for the operator's actual build/version.
- That the resampling and subprocess-piping latency is low enough for
  usable real-time two-way voice on a Raspberry Pi, particularly given
  each PTT press spawns a fresh `lpcnet_demo` process (a neural-vocoder
  model load) rather than keeping one warm — see "Known gaps carried over
  from earlier phases" below.
- Anything about actual RF/audio quality, or interoperability with
  another real RADE station.

Beyond this project's own testing gap, **upstream rade_c itself currently
says RADE V2 "is under active development," with "the waveform, model
weights, and API...subject to change without notice," and "on-air use is
not recommended at this stage"** (per its own README, current as of when
this was written) — while V1 carries none of those caveats and is
documented with working examples. Because of that gap, this bridge
**defaults to V1** (`RADE_VERSION` env var unset, or anything other than
the literal string `v2`); V2 is opt-in only, via `RADE_VERSION=v2`, for
anyone who specifically wants to experiment with it at their own risk per
upstream's own warning. Both ends of a link must still agree on which
version is in use, same as any modem. Test this thoroughly (a local
loopback between two stations, or at minimum a recording round-trip)
before trusting either version for an actual QSO.

### Real bug found: `lpcnet_demo` exiting immediately with `code=1` on RX

A user running this bridge against their own compiled rade_c binaries hit
`Audio error: rade-rx: stage "lpcnet_demo" exited unexpectedly (code=1,
signal=null)` as soon as RADE mode activated. Reading `lpcnet_demo.c`'s
actual `main()` (the file backing the `lpcnet_demo` binary, from
rade_c) shows it has exactly two `exit(1)` call sites, both from a
`fopen()` failure on its input/output filename argument — and, critically,
that its stdin/stdout special case is triggered *only* by the literal
single-character string `"-"` (`strcmp(argv[2], "-") == 0` /
`strcmp(argv[3], "-") == 0`); anything else, including the string
`/dev/stdin`, is instead passed straight to `fopen()` as a real filename.
This bridge's pipeline stages were invoking it with `/dev/stdin` as the
input argument (`['-fargan-synthesis', '/dev/stdin', '-']` on RX,
`['-features', '/dev/stdin', '-']` on TX) — a filename that happens to
work via `fopen()` on many Linux systems (it's normally a symlink to
`/proc/self/fd/0`), but isn't the binary's own documented/special-cased
marker for "read from stdin," and evidently doesn't resolve reliably in
every environment `lpcnet_demo` might run in. Both stages now use the
literal `"-"` for both their input and output arguments
(`['-fargan-synthesis', '-', '-']` / `['-features', '-', '-']`), matching
exactly what the binary's own argument parsing checks for, rather than
relying on `/dev/stdin` resolving correctly. This is the most likely fix
given what `lpcnet_demo.c`'s source actually does, but — same as
everything else about this bridge — it hasn't been verified against the
operator's real binaries or hardware from this environment; if the error
recurs, the next thing to check is `lpcnet_demo`'s own stderr output
(logged server-side as `[rade-rx] ...`/`[rade-tx] ...`) for a `"Can't
open %s"` message naming which argument it failed on.

### Real bug found: RADE RX produced no audio at all (no crash, no error)

After the `lpcnet_demo` crash above was fixed, a user confirmed no more
crash, but RX of a real RADE signal produced no decoded audio — silence,
not an error. The most likely explanation, given what's now known about
these tools: rade_c's binaries were written and documented (per their own
README) as **batch converters over complete files**, not as continuous
real-time streams. C's stdio library fully-buffers `stdout` by default
whenever it isn't attached to a terminal — which is exactly the case for
every stage in this bridge's pipelines, since each one's stdout is a pipe
either to the next stage or back into this bridge. A batch tool has no
reason to care about that: it just writes everything and the buffer
flushes at exit, after the whole file's been processed. A live pipeline
fed a continuous trickle of audio is a completely different story — a
stage can sit on already-decoded audio for a long time (worst case,
indefinitely, until the pipe eventually closes) instead of handing it
downstream as it's produced, which from this bridge's point of view is
indistinguishable from "nothing is happening."

`RadePipeline` (`src/audio/rade-pipeline.js`) now wraps every stage in
`stdbuf -o0 -e0` (a standard coreutils tool, expected to already be
installed on any Debian/Raspberry Pi OS system) by default, which forces
unbuffered stdout/stderr on each stage without needing to touch or
rebuild rade_c itself — this is a standard, well-known fix for exactly
this "piped-together CLI tools go silent" symptom. `RadePipeline` takes a
new `unbuffered` constructor option (default `true`) so this can be
disabled if `stdbuf` genuinely isn't available on a given system.

**Not verified against the operator's real binaries from this
environment** — same caveat as everywhere else in this section. If RX
(or TX) still produces no audio after this fix, the next things to check
by hand on the actual Pi: that `stdbuf` is on `PATH` (`which stdbuf`,
part of GNU coreutils); watching the server's console for `[rade-rx]`/
`[rade-tx]` stderr lines while a signal is present, to see whether
`radae_rx` is actually decoding anything at all (as opposed to a
buffering problem specifically); and whether a `--v2`/no-`--v2` mismatch
between this station's `RADE_VERSION` and the transmitting station's is
causing `radae_rx` to run but never lock onto/decode the signal (both
ends must agree — see this section's own "Genuinely unverified" notes
above on RADE V1 vs V2).

### Real bug found: `real2iq` in the wrong pipeline, and every RADE boundary treated as plain 16-bit PCM

After the buffering fix above, a user confirmed `radae_rx` was spawning
and running with no crash, but **still** produced no RX audio on an
active RADEV1 transmission — and separately reported that RADE TX
produced almost no output power at all (whistling into the mic in SSB
generated ~100W; the same test in RADE mode barely moved the needle).
Both symptoms turned out to share one root cause, and it wasn't a timing
or buffering problem this time: this bridge had the entire RX/TX data
format wrong at the boundary between the native rade_c tools and
everything else.

The original code put `real2iq` **last in the TX chain** (after
`radae_tx`) and **nowhere in the RX chain**, on the assumption that
`real2iq` converted `radae_tx`'s complex-IQ output back into a real
waveform for the radio. Reading `real2iq.c` directly (it ships as part of
rade_c itself) shows the exact opposite: it only ever converts **real
samples into complex IQ**, via a 127-tap Hilbert-transform FIR filter —
there is no "iq2real" tool anywhere in rade_c, and its own documented
example pipelines only take `radae_tx`'s output as far as a raw `.iq`
file, never back to a real radio signal. So `real2iq` belongs on **RX**
(converting the radio's real received audio into the complex IQ
`radae_rx` expects on stdin), not TX — confirmed against a real-world
reference implementation, the peterbmarks/radae_decoder GUI client, which
does exactly that on RX and, on TX, simply takes the real part of
`radae_tx`'s complex output itself (see "Why this needed two chained
subprocesses per direction, not one" above for the corrected pipeline
this bridge now uses).

Layered on top of the misplaced stage, every JS-side conversion at these
two boundaries was also using `resamplePcm()` — a helper built entirely
around 16-bit PCM — on data that was never PCM to begin with:

- **RX boundary (radio audio -> `real2iq`'s stdin):** `real2iq.c` reads
  raw 4-byte `float` samples via a plain `fread()`, no header or framing.
  Feeding it 16-bit PCM instead silently reinterprets every 2 bytes of
  real audio as half of an unrelated 4-byte float — not a crash, just
  noise that `radae_rx` can never lock onto as a valid modem signal,
  which matches exactly what was reported ("does successfully spawn
  ... but there is no audio").
- **TX boundary (`radae_tx`'s stdout -> the radio):** `radae_tx`'s actual
  output is **complex float32 IQ**, interleaved `I,Q,I,Q,...` at 8kHz —
  twice the byte width of PCM, and half of it (the Q component) isn't
  audio at all. Piping that straight through a PCM resampler treated
  every 4-byte float as two unrelated 16-bit integers, so the real (I)
  component — the only part that should ever reach the radio — was never
  isolated, scaled, or even correctly byte-aligned. The result is
  low-level, largely meaningless audio reaching the mic input, which
  matches "little or no power in the transmission" — not a gain problem
  so much as feeding the radio mostly noise at a low level.

**The fix**, in `src/server/rade-bridge.js`: `real2iq` moved to be the
first RX stage (ahead of `radae_rx`); the RX audio hop now converts radio
PCM to raw float32 samples (`float32ArrayToRawBytes()`) instead of
resampling as PCM; `real2iq` was removed entirely from TX; and a new
`extractRealFromComplexFloat32()` helper now reads `radae_tx`'s complex
float32 stdout, takes just the real (I) component (discarding Q), applies
a gain, and hands the result to `upsampleFloatToPcm()` for the trip back
to the radio — mirroring the reference GUI client's own "take real part,
scale by TX output level" step. That gain is exposed as a new
`RADE_TX_GAIN` env var (`txGain` on `RadeBridge`'s constructor, default
`1`, i.e. `radae_tx`'s own real-part output level is trusted as-is) —
this is called out separately in "Genuinely unverified" above, since
there's no way to check the "correct" TX drive level against real
hardware from this environment; if TX still reads low (or clips) once
this fix is in place, `RADE_TX_GAIN` is the knob to reach for.

**Not verified against the operator's real binaries or hardware from
this environment** — same caveat as everywhere else in this section, but
worth repeating here since this was, at the time, the deepest and most
consequential bug found in this bridge so far: the earlier `stdbuf` fix
above was real and necessary (a live pipeline genuinely does need
unbuffered stdio), but it was fixing a problem sitting on top of this one
— even with buffering fixed, `radae_rx` was still being handed the wrong
data shape entirely, and `radae_tx`'s real output was still being mangled
on the way out. **This diagnosis turned out to be necessary but still not
sufficient — see the next section**, which found `real2iq` itself is
fundamentally the wrong tool for this job, on top of everything above.

### Real bug found: `real2iq` doesn't belong in a live pipeline at all, and both boundaries used the wrong scale

After the fix above shipped, the user confirmed RADE TX now reads full
power on their transceiver's meter — but RX was still completely silent
on an active RADEV1 transmission, unchanged from before. That ruled out
buffering (already fixed) and the gross PCM-vs-float32-vs-complex-IQ
format mismatch (also already fixed) as the *remaining* RX cause, which
meant the previous diagnosis, while a real improvement, had missed
something underneath it. Re-reading rade_c's actual source for every tool
involved — not just `real2iq.c` again, but `radae_rx.c`, `radae_tx.c`,
`rade_api.h`, and `rade_demod_wav.c` (a combined demod+vocoder tool rade_c
ships specifically for decoding real-valued off-air/WAV audio) — turned
up two further problems, one of which fully explains the continued RX
silence on its own:

1. **`real2iq` is not a streaming tool, no matter where it sits in the
   chain.** Its `main()` does `while ((nread = fread(...)) > 0) { ...
   accumulate into one big buffer ... }` — a loop that only exits on EOF —
   and *only after that loop ends* does it allocate an output buffer,
   run the Hilbert transform over the whole thing, and `fwrite()` the
   entire result in one call, then exit. It is a batch, whole-file
   converter: it cannot and does not write a single byte of output until
   its stdin is closed. This bridge's RX audio stream is exactly the
   thing that's never supposed to close while RX is armed — so with
   `real2iq` anywhere in the RX chain, `radae_rx` downstream of it can
   never receive anything at all, no matter how correctly-formatted the
   data feeding `real2iq` is. This is the direct explanation for why RX
   stayed silent even after the previous fix corrected the data format:
   the format was right, but the very first stage in the chain was
   architecturally incapable of passing anything through in real time.
2. **Even set aside the streaming problem, `real2iq`'s Hilbert-transform
   conversion isn't what rade_c's own reference tool uses for real-valued
   RX input in the first place.** `rade_demod_wav.c` — rade_c's own
   "reads a WAV file of received RADE audio, writes decoded speech"
   utility — builds its complex IQ with a plain loop, `iq[i].real =
   audio[i]; iq[i].imag = 0.0f;`, with this comment directly in the
   source: "The OFDM carriers sit at 1062-1875 Hz; the negative-frequency
   mirror of a real signal falls at -1875 to -1062 Hz and is rejected by
   the OFDM correlators, so no Hilbert transform is needed." In other
   words, upstream's own answer to "how do I feed real SSB-radio audio to
   `radae_rx`" is: don't Hilbert-transform it, just zero-fill the
   imaginary part.
3. **Both boundaries were also using the wrong numeric scale.**
   `rade_api.h` documents a dedicated `RADE_INT16_SCALE` constant
   (`16384.0`) for exactly this int16-to-float boundary, and it is *not*
   the same as the generic "int16 full-scale" convention (32768) this
   codebase's other PCM helpers use — see "The `RADE_INT16_SCALE` scaling
   convention" above for the exact formulas, confirmed against
   `rade_demod_wav.c`'s own `wav_read_mono_float()` (`tmp * (2.0f /
   RADE_INT16_SCALE)`) and `rade_api.h`'s own comment block for
   `rade_tx()`'s output (`int16 = Re{...} * RADE_INT16_SCALE`). This
   bridge previously used the generic 32768-based scale on both ends —
   on RX that's a 4x-too-quiet signal (on top of never arriving at all,
   because of point 1 above); on TX it's *exactly 2x too loud*, which
   lines up precisely with the "TX reads full power" report: that
   reading wasn't confirmation the fix was correct, it was overdriving —
   nominal-amplitude audio that should top out at int16 16384 (rade_c's
   own documented 6dB-headroom convention) was being scaled all the way
   to 32767, i.e. clipped at roughly twice the intended level.

**The fix**, in `src/server/rade-bridge.js`: `real2iq` is now removed
entirely from this bridge (both directions) — RX builds its complex IQ
directly in JS via a new `realFloatToZeroImagIq()` helper (real part =
downsampled radio audio scaled by `RADE_INT16_SCALE`'s documented
real-input formula, imaginary part always zero, matching
`rade_demod_wav.c`'s approach), and feeds that straight to `radae_rx`'s
stdin with no intermediate subprocess at all. TX's real-part extraction
(`extractRealFromComplexFloat32()`) now also applies the `RADE_INT16_SCALE`
correction (effectively halving the previous output level) before
`RADE_TX_GAIN` and the existing PCM packing/resampling. `RADE_INT16_SCALE`
itself, and the two small rescale constants that reconcile it with
`resample.js`'s generic-PCM-scaled helpers, are documented at the top of
`rade-bridge.js` with the derivation spelled out. The `REAL2IQ_BIN` env
var and `real2iqBin` constructor option have been removed entirely (see
README.md) — rade_c can still be built with `real2iq` present on the
system, it's simply never invoked by this app now.

**Not verified against the operator's real binaries or hardware from
this environment** — same caveat as ever, but this is now the second time
"the RX chain runs without error" has turned out to hide a real problem,
so it bears spelling out precisely what to check if RX is *still* silent
after this fix: watch `radae_rx`'s own stderr (logged as `[rade-rx] ...`)
while a real signal is present — its `radae_rx.c` prints
`nin_max:`/`n_features_out:`/`n_eoo_bits:` once at startup and a final
`Processed N input OFDM symbols, M valid outputs` summary on exit; a
nonzero `N` with `M` staying at `0` throughout means samples are reaching
it but it's never syncing (check `RADE_VERSION`/`--v2` agreement between
stations, and signal level/SNR), whereas `N` staying at `0` means samples
still aren't reaching it at all (check that `audioBridge.capture` is
actually emitting `'data'` while RX is armed, i.e. that ALSA capture
itself is running). For TX, comparing the actual transmitted audio (a
second radio or SDR listening to this station) against a known-good RADE
recording is the only way to confirm the `RADE_INT16_SCALE` fix landed on
a sensible drive level rather than just "less clipped than before."

### Real bug found: reverting the `RADE_INT16_SCALE`-based TX scaling

After the fix above shipped, the user confirmed RX now works — but a
remote station reported this station's RADE TX signal was now too weak,
where it had reportedly been good before. That "before" was the version
with the TX scaling bug the *previous* section fixed (full int16
full-scale, effectively 2x over `RADE_INT16_SCALE`'s documented level) —
so the ordering of events was: full-scale TX reads "good" over the air ->
switched to `RADE_INT16_SCALE`'s documented (half-of-full-scale) TX level
-> reads "too low" over the air, on the same real link. Taken together,
that's direct on-air evidence that `rade_api.h`'s documented TX headroom
convention, whatever it's correct for in general, is not the right level
for *this* app's actual transmit chain specifically — most likely because
that convention is about not clipping the OFDM waveform's peaks in the
purely digital domain (feeding a real IQ-capable SDR directly), while this
app's actual path from `radae_tx`'s output to the transceiver's mic input
goes through this app's own ALSA playback and the radio's own audio
input staging (already tuned elsewhere in this app for full-scale digital
drive — see `CIV_MAXIMIZE_USB_LEVELS` and the ALSA-side `amixer`
maximization in README.md/index.js), which apparently expects and handles
full-scale digital audio just fine.

Rather than guess further from this environment (no access to the real
radio or a second real station to test against), this bridge now simply
reverts to the pre-`RADE_INT16_SCALE` TX behavior: `_handleModulatedAudio()`
extracts `radae_tx`'s real (I) component and hands it to
`upsampleFloatToPcm()` with only `RADE_TX_GAIN`/`txGain` applied on top —
no `RADE_INT16_SCALE`-derived rescale — so nominal-amplitude audio again
lands at (close to) int16 full-scale, matching the level the remote
station confirmed was working. The RX-side use of `RADE_INT16_SCALE` is
**not** affected by this revert — RX was independently confirmed working
by the same user in the same round of testing, so it's kept exactly as
the previous section describes. This asymmetry (RX applies
`RADE_INT16_SCALE`, TX doesn't) is real and intentional, not an
inconsistency to "fix" later — see "The `RADE_INT16_SCALE` scaling
convention" above.

**Not verified beyond this one on-air data point.** If TX still reads low
after this revert, `RADE_TX_GAIN` (see its own doc comment in
`rade-bridge.js` and README.md) is the knob to reach for next — e.g.
`RADE_TX_GAIN=1.5` or `2` for a further boost on top of the now-reverted
full-scale baseline. If TX instead now reads *too hot* / distorted for
some radios, `RADE_TX_GAIN` below `1` (e.g. `0.5`, which recovers
`RADE_INT16_SCALE`'s original headroom-scaled level exactly) is the way
back down without re-editing code.

### Real bug found: only ~20% modulation with the reverted full-scale TX level

Exactly the "TX still reads low after this revert" case the previous
section anticipated: a remote station later reported this station's
FreeDV RADE transmission was only reaching about 20% modulation, with
`RADE_TX_GAIN` still at its default. That default was `1` — i.e. no
extra gain at all beyond the full-scale (not `RADE_INT16_SCALE`-headroom)
level the previous fix restored — so the previous section's revert fixed
the *direction* of the bug (TX audio is present and roughly the right
shape) but not the *level*: `radae_tx`'s raw real-part output, taken
straight to int16 full-scale with nothing else applied, apparently only
occupies about a fifth of this app's actual TX audio chain's headroom.

Rather than leave every fresh install to rediscover this exact same gap
by ear (or a remote station's signal report, as happened here),
`RadeBridge`'s `txGain` and `index.js`'s `RADE_TX_GAIN` parsing both
changed their fallback default from `1` to **`4`** — a real-world-informed
correction (would read roughly 80% modulation at this same reporting
station's operating point), deliberately short of the `5` a literal
"scale 20% up to 100%" calculation suggests, to leave some headroom
against clipping the OFDM waveform's peaks (which typically run hotter
than whatever produced the reported average/ALC-style 20% reading in the
first place — clipping those peaks would be a worse failure mode than
running a bit under 100%). This is still just one more real-world data
point layered on the last one, not an independently confirmed correct
value — `RADE_TX_GAIN` remains the way to tune further in either
direction (see its own doc comment in `rade-bridge.js` and README.md):
higher if 4x still reads low on a given radio/audio chain, or below 1 if
it now clips/distorts.

`test/rade-bridge.test.js`'s "only the real (I) part... reaches the
radio" test explicitly passes `txGain: 1` now, to keep verifying the
real/imaginary-extraction behavior itself independent of whatever the
current default gain value happens to be; a separate test covers the
default-value change directly.

## FreeDV Reporter integration (`src/server/freedv-reporter.js`)

At the user's request, arming the client's FreeDV chip (either variant)
now also registers this station on [FreeDV Reporter](https://qso.freedv.org)
— the live activity map/station list FreeDV operators use to see who's on
the air and on what frequency, the FreeDV equivalent of what PSK Reporter
(above) is for FT8.

**Protocol.** FreeDV Reporter's server is a Socket.IO v4 service (a
different protocol from PSK Reporter's IPFIX/UDP one above — these are
two unrelated services). There's no official written API spec for it;
this was built against a third-party client's own reverse-engineered
documentation (`Reporter_api.md` from
[peterbmarks/radae_decoder](https://github.com/peterbmarks/radae_decoder),
itself sourced from the server's own `bitbucket.org/tmiw/freedv-reporter`
repo), and cross-checked against what the official `freedv-gui` client
and its `USER_MANUAL.md` say about the feature (TLS by default, callsign/
grid-square/version required, "hide self" support) — not from guessing.
Implemented with the official `socket.io-client` npm package (handles the
Engine.IO/Socket.IO handshake, ping/pong, and event framing) rather than
hand-rolling the wire frames, unlike at least one other third-party client
found during research that hand-rolled its own minimal Socket.IO client
instead — `socket.io-client` is a well-maintained, widely-used dependency
and there's no reason to reimplement it here.

**Role: `report_wo`.** Of FreeDV Reporter's three connection roles
(`view` — read-only; `report` — reports and can see other stations;
`report_wo` — "reports but cannot view others", the role the official
ezDV client uses), this bridge always connects as `report_wo`: this app
has no station-list/map UI of its own, so there's no use for the (fairly
chatty) stream of every other station's connects/disconnects/frequency
changes/chat that the `report` role would also deliver — this only ever
*sends* this station's own state.

**When it connects/disconnects.** Only while a client has the FreeDV chip
armed (`SET_FREEDV_ACTIVE` — the same event `RadeBridge` reacts to, see
"The RADE codec bridge" above), and only if `STATION_CALLSIGN`/
`STATION_GRID` are both configured (same precondition PSK Reporter already
has — see its own section above; FreeDV Reporter's own auth rejects a
`report`/`report_wo` connection missing either field, and there's no
other source of the operator's identity in this app). Deliberately covers
**both** the '700E' and 'RADE' variants at the mechanism level, not just
'RADE' — even though the client's own UI can no longer select anything
but 'RADE' any more (see "FreeDV mode" above's "700E was removed" note):
from another operator's point of view "this station is on FreeDV" would
be equally true for either, since the radio's own USB + DATA MODE state
is identical for both. Disarming FreeDV (or leaving it for any other mode)
disconnects cleanly, so a station doesn't linger as a stale/ghost entry
on the live map after the operator has actually moved on.

**What's reported.** `freq_change` (on connect, if a frequency is already
known, and on every subsequent CI-V frequency change while connected —
see `ControlServer`'s new internal `'frequency'` event, added for this,
in its own doc comment) and `tx_report` (on connect, and again on every
PTT or FreeDV-variant change, carrying the current variant string as
`mode` and PTT state as `transmitting`). No callsign-of-heard-station
reporting (FreeDV Reporter's own `rx_report` event) — RADE doesn't
currently decode a remote callsign out of the audio stream at all (see
"The RADE codec bridge" above), so there's nothing to report there yet.

**Enable/disable — two layers.** `FREEDV_REPORTER_ENABLED` env var
(default on, matching this app's own convention for `pskSpotEnabled`) is
the ops-level kill switch — an operator running the server can opt out
without having to unset `STATION_CALLSIGN`/`STATION_GRID` (also used for
FT8's default CQ message and PSK Reporter). On top of that, at the user's
explicit follow-up request, there's now a **"FDV Spot" checkbox**
(labeled "FreeDV spot" until a later rename request, shortened to match
the space this checkbox actually has) in the UI —
`REQUEST.SET_FREEDV_SPOT_ENABLED` / `EVENT.FREEDV_SPOT_ENABLED` in
`protocol.js`, `ControlServer.state.freeDvSpotEnabled`, and an internal
`'freedv-spot-enabled'` event `FreeDvReporterBridge` listens for — the
exact same shape as `SET_PSK_SPOT_ENABLED`/`'psk-spot-enabled'` above,
except for one deliberate difference: **it defaults to `false`**, per the
explicit request ("It should be unselected by default"), unlike PSK
Spot's default-on checkbox. `FreeDvReporterBridge` only ever connects
when *both* this checkbox is checked *and* FreeDV is armed (`_enabled`
in `freedv-reporter.js` requires callsign + grid + this flag together);
toggling the checkbox off mid-session disconnects immediately rather
than waiting for FreeDV to also be disarmed, since unchecking it while
already reporting clearly means "stop now."

**Update**: the checkbox was initially left visible at all times, on the
theory that an operator would want to arm it ahead of switching into
FreeDV. Per explicit follow-up request, it's now shown **only while
FreeDV mode is actually active** — matching how "PSK Spot" is only shown
during FT8 mode. `freeDvSpotLabel.hidden` is set `true` at creation, set
`false` in `enterFreeDvMode()`, and set back to `true` in
`exitFreeDvMode()`; `styles.css` has the matching
`.freedv-spot-toggle[hidden] { display: none; }` override (the same
`[hidden]`-needs-an-explicit-override pattern `.psk-spot-toggle` already
uses, since an author-specified `display: flex` otherwise beats the
browser's own `[hidden]` rule at equal specificity).

**Placement**: originally sat inline in `.controls-row`, right after the
Tune button. Per a later explicit request ("Move the FreeDV Spot (FDV
Spot) button to below the filter button"), it now lives in the
function-controls column instead, inserted directly after the Filter
button (`FUNCTION_CONTROLS.find((c) => c.key === 'filter')`, the same
`insertAdjacentElement('afterend', ...)` pattern "PSK Spot" uses after the
Notch button) — Filter being the last `FUNCTION_CONTROLS` entry, this
checkbox now lands at the very bottom of that column. Its class picked up
`function-control__button` to match that column's sizing, and
`.freedv-spot-toggle`'s CSS was updated to mirror `.psk-spot-toggle`'s
left-aligned checkbox layout instead of the plain `.chip` styling it used
while sitting inline next to Tune. The checkbox's
checked/unchecked state itself is untouched by this — it's still synced
server-side and restored from the `'connected'` snapshot regardless of
whether it's currently visible, so arming FreeDV re-shows it in whatever
state it was last left in.

**Genuinely unverified**, same caveat as the rest of this project's
network-facing integrations: no access to the real qso.freedv.org service
from wherever this was written/reviewed. The bridge's own connect/
disconnect and event-emission logic is unit-tested against an injected
fake Socket.IO client (`test/freedv-reporter.test.js`), but the only real
way to confirm this end-to-end is to arm FreeDV with `STATION_CALLSIGN`/
`STATION_GRID` configured and check that the callsign actually appears on
https://qso.freedv.org's live map. If it doesn't, check the server
console for `[freedv-reporter]` connect-error logging first.

**Update — a real qso.freedv.org session surfaced three issues once this
was actually exercised against the live service:**

1. **`socket.io-client` "Cannot find module" when checking the box.** Not
   a code bug — `defaultSocketFactory()` (in `freedv-reporter.js`)
   deliberately `require('socket.io-client')`s lazily, only on the first
   real connection attempt, "so a missing/broken socket.io-client install
   can't break unrelated server startup paths." `package.json` has always
   correctly listed it as a dependency, so this only ever means the
   deployed `node_modules` is stale (predates this feature, or was copied
   over rather than reinstalled) and never actually got the package. Fix:
   `npm install` on the deployed machine, then restart the server —
   nothing to change in the code.
2. **Frequency reported as "0.0000 MHz".** `_freqHz` started `null` and
   only ever got set reactively off `controlServer`'s `'frequency'`
   event. `ControlServer.listen()`'s startup priming (see "Frequency/mode
   are primed at server startup" above) sets `state.frequency` directly,
   without emitting that event — and this bridge is constructed only
   *after* `listen()` resolves anyway (see `src/server/index.js`), so it
   couldn't have caught the emit even if `listen()` made one. Fixed by
   seeding `_freqHz` from `controlServer.state.frequency` right in the
   constructor — the same already-primed value a freshly-connected
   client's own `'connected'` snapshot reads — instead of waiting on an
   event that was never coming.
3. **RADE reported as bare `"RADE"` instead of `"RADEV1"`/`"RADEV2"`.**
   The V1 and V2 RADE waveforms aren't interoperable (see "The RADE codec
   bridge" below and `RADE_VERSION` in `README.md`), so reporting just
   `"RADE"` doesn't tell another operator which one this station can
   actually decode. `tx_report`'s `mode` field is now built by a new
   `_reportedMode()` method, which appends this server's own
   `radeVersion` option (`'v1'`/`'v2'`, passed through from
   `RADE_VERSION` in `src/server/index.js`, same default) to the variant
   name whenever it's `'RADE'`, giving `'RADEV1'`/`'RADEV2'`. `'700E'`
   has no version split and is still reported as-is.

Also, per explicit follow-up request, the `version` string sent in the
auth payload is now the fixed string `'PiRO - FreeDV 2.4.0'`
(`src/server/index.js`) rather than this project's own `package.json`
version — FreeDV Reporter has no reason to recognize `icom-rig-pwa`'s
internal version number, and this instead matches the project's own
"PiRO" naming (see `SCREEN_TITLE`'s default) plus the FreeDV protocol
version this station is interoperable with.

### Status message (`message_update`)

Per explicit follow-up request, the bridge also sends FreeDV Reporter's
`message_update` event (see `Reporter_api.md` in the RADE decoder repo
for the third-party protocol doc this is built against, same source as
`tx_report`/`freq_change` above) — a freeform status string like "Looking
for contacts", set from a new text field + "Set" button in the UI
(`#freedv-report-section`, shown only while FreeDV mode is armed, same
visibility rule as the "FDV Spot" checkbox).

`REQUEST.SET_FREEDV_MESSAGE` -> the internal `'freedv-message'` event ->
`FreeDvReporterBridge#setMessage()` -> `message_update`. This is standing
state — cached (`ControlServer.state.freeDvMessage`, default `''`) and
broadcast (`EVENT.FREEDV_MESSAGE`) — so it survives a reconnect/
page-reload (restored from the `'connected'` snapshot) and stays in sync
across multiple connected browser tabs, the same persistent-checkbox
pattern `freeDvSpotEnabled` already uses. It's also (re-)sent on every
FreeDV Reporter connect, even when it's `''` — so re-arming FreeDV after
a disarm restores whatever was last set (rather than the other station's
map view showing a stale message from before the disarm), and an
explicitly-cleared message actually clears instead of leaving the
previous one behind. Sending it while not actually connected to FreeDV
Reporter (e.g. "FreeDV spot" unchecked) is harmless — the bridge's
`_emit()` no-ops without a live socket, same as every other event this
bridge sends.

**Reverted: RX spot (`rx_report`).** An earlier version of this feature
also added a manual "Spot" row (callsign + SNR fields, sending FreeDV
Reporter's `rx_report`) — reverted per explicit follow-up request. Before
it was reverted, it was already built as manual-entry-only rather than
auto-decoded: `radae_rx`, the actual binary `rade-bridge.js` spawns for
RX (not the GTK GUI or `webrx_rade_decode` tool the wider RADE decoder
repo also ships), has no callsign-extraction logic and no SNR output at
all — just an "End-of-over detected" line and a final frame-count summary
to stderr. That's still true; nothing about the revert changes it. If
this is revisited, "Known gaps" below is the place future readers will
look.

## RNN noise reduction (the "RNN" toggle, `src/audio/rnnoise-filter.js`)

A new "RNN" checkbox button sits in the RX function-controls row, in the
exact slot the old Noise Blanker ("NB") button used to occupy (P.Amp / NR
/ **RNN** / Notch / Filter) — the NB button itself was removed from the
screen entirely per explicit request. Unlike the FDV Spot
checkbox, it's always visible, not gated on any particular mode being
armed. Checking it spawns (lazily, the first time it's switched on) a
persistent `rnnoise_demo` child process — the demo binary from
[github.com/xiph/rnnoise](https://github.com/xiph/rnnoise)'s `examples/`
directory — and threads the actual RX PCM audio through it before that
audio reaches the client (so the operator hears the effect of
enabling/disabling it directly). See
`RNNOISE_BIN` in README.md for the env var that names/locates the binary.

**Why this is scoped to client audio + STT only, and deliberately never
touches CW/RTTY/FT8/FreeDV decoding:** RNNoise is a speech-denoiser, not a
general audio filter — running it over CW tones, RTTY AFSK tones, FT8
tones, or FreeDV's raw modem waveform would corrupt exactly the signal
shape those decoders need to see, since none of that is actually speech.
`AudioBridge` (`src/server/audio-bridge.js`) filters at exactly one
point — the single internal listener that already decides what gets
broadcast to clients in PCM mode — and only ever publishes either the raw
captured chunk (RNNoise off) or the filter's own output (RNNoise on) via
a new `'rx-pcm'` event, for any other server-side listener that needs to
hear exactly what the operator hears rather than the raw pre-filter
capture.
Every other decoder — `CwDecoderBridge`, `RttyDecoderBridge`, `Ft8Bridge`,
and `RadeBridge` (FreeDV) — keeps tapping `audioBridge.capture`'s raw
`'data'` event completely independently, and Node's `EventEmitter` calls
every listener with the same, unmodified event data, so nothing RNNoise
does can affect what those decoders see, regardless of the toggle's
state. `test/audio-bridge.test.js` has a dedicated regression test
confirming a raw `capture.on('data', ...)` listener sees byte-identical
chunks whether RNNoise is enabled or disabled.

RNNoise expects 48kHz, 16-bit signed little-endian mono PCM; the filter
reads the configured sample rate from `audioBridge.sampleRate` rather than
hardcoding 48000, but this app does not resample audio to match it — if
the configured `AUDIO_RX_DEVICE` capture rate isn't 48kHz, RNNoise's own
denoising quality (not this app's plumbing) is what's untested at other
rates.

Fully defensive by design: if `rnnoise_demo` isn't installed/on PATH, or
the child process exits unexpectedly mid-stream, `AudioBridge` reports an
`AUDIO_ERROR` and automatically falls back to unfiltered passthrough
rather than breaking RX audio or crashing the server — it never retries
or auto-restarts the filter; the operator has to re-toggle "RNN" (which
lazily spawns a fresh process) to try again. The toggle is a no-op with a
logged/broadcast error in that failure case, not a hang or a silent
audio outage.

### Genuinely unverified

Like the RADE codec bridge and FreeDV Reporter integration above, this
was built and unit-tested entirely against a stubbed/injectable
subprocess (`test/rnnoise-filter.test.js`'s fake `child_process.spawn`)
mirroring `RadePipeline`'s own established spawn/pipe pattern — there's no
way to build or run the real `rnnoise_demo` binary from wherever this
project's code gets written/reviewed. What's genuinely unverified: the
real binary's stdin/stdout framing and buffering behavior (whether it
expects/produces fixed-size frames — RNNoise's own algorithm works on
480-sample/10ms frames internally — or tolerates arbitrary chunk
boundaries the way this pipe-based integration assumes), its actual
audio-quality effect on real, noisy HF/VHF voice audio, and its process
resource usage/latency running continuously alongside the rest of this
app's audio pipeline on a Raspberry Pi. If the real binary turns out to
require strict frame-aligned input/output rather than tolerating whatever
chunk sizes `AudioBridge`'s own capture callback happens to hand it, this
integration may need an added framing/buffering layer — same caveat as
the RADE codec bridge's own pipe-framing notes below.

## HamNoise noise reduction (the "HamNoise" toggle, `src/audio/hamnoise-filter.js`)

A second checkbox button, "HamNoise", sits immediately beneath "RNN" in
the same RX function-controls column. Checking it on and checking "RNN"
on are mutually exclusive — per explicit request, selecting either one
disables the other automatically, in both directions, and the toggle that
got forced off reflects that on every connected client's screen, not just
the one that triggered it (see `AudioBridge#setRnnoiseLevel()` and
`#setHamNoiseEnabled()` in `src/server/audio-bridge.js`, which each call
the other's internal disable path and broadcast the resulting reset).
Both remain completely independent of, and safe to combine with, the
radio's own hardware "NR" button — that's a separate stage entirely
upstream in the actual RF/analog signal chain, not something either of
these two RX-audio-stream denoisers has any visibility into.

HamNoise ([github.com/e04/HamNoise](https://github.com/e04/HamNoise)) is
architecturally unrelated to RNNoise above (a band-split RNN rather than a
single GRU) and unrelated to this project's own "CW 3"/DeepCW decoder (a
CNN+CTC decoder that reads the raw, undenoised capture tap directly, never
this filtered broadcast path) — see `models/hamnoise/NOTICE.md` for the
detailed architecture writeup. It runs over exactly the same RX-broadcast
scope as RNNoise, for the identical reason given in "RNN noise reduction"
above: CW/RTTY/FT8/FreeDV decoding all tap `audioBridge.capture`'s raw
`'data'` event directly and never see HamNoise-filtered audio, regardless
of the toggle's state. `test/audio-bridge.test.js` has the same kind of
regression test as RNNoise's confirming this.

Unlike RNNoise (one model, one spawned subprocess), HamNoise ships two
separately-trained, separately-compiled WASM models — one for CW, one for
voice/SSB — and this app automatically loads whichever one matches the
radio's current operating mode (tracked via the optional `civ` reference
`AudioBridge` is constructed with, listening for the same `'mode'` event
`CwDecoderBridge`/`RttyDecoderBridge` already rely on —
see `CivDriver#setMode()`'s own doc comment for why that event is now
reliably emitted). There's no separate client-facing control for this —
switching between a CW mode and a voice mode while HamNoise is already
running switches its active model live, with a brief, infrequent
discontinuity rather than a crossfade (not a hot path — see
`hamnoise-filter.js`'s own doc comment for why that's an acceptable
trade-off here). No binary install or env var is needed: the two WASM
files are bundled directly under `models/hamnoise/` and run in-process via
Node's built-in `WebAssembly` support — see that directory's `NOTICE.md`
for exactly which files, which commit, and the licensing implication
(same AGPL-3.0 family as the DeepCW bundle — see README.md's "Licence"
section).

Fully defensive by design, the same posture as RNNoise: a failed model
load/init/select, or a runtime processing failure, reports an
`AUDIO_ERROR`, resets the toggle to off for every connected client, and
falls back to unfiltered passthrough rather than breaking RX audio or
crashing the server. Unlike RNNoise's subprocess (where a failure only
ever reaches `AudioBridge` through the filter's own `'error'` event),
HamNoise's WASM calls (`stop()`, `write()`, `setModel()`) run synchronously
in-process on `AudioBridge`'s own call stack — toggling the button, every
captured audio chunk, and a radio mode change while it's running are each
a direct, unguarded call into that native boundary. A real crash report
(the server process dying specifically when the operator disabled the
toggle) showed this gap: `AudioBridge` now wraps all three call sites in
try/catch (`_stopHamNoiseFilterSafely()`, `_writeHamNoiseFilterSafely()`,
and `_handleCivModeChange()`'s own guard around `setModel()`), converting
any synchronous throw into the same `AUDIO_ERROR`-plus-toggle-reset
fallback a `HamnoiseFilter`-reported `'error'` event already gets, instead
of letting it propagate and take the whole server down. This is defense
in depth, not a replacement for proper error handling inside
`hamnoise-filter.js` itself — see that file's own doc comment — but it
means a WASM-boundary failure this project hasn't anticipated can no
longer crash the process outright. `test/audio-bridge.test.js`'s "a
throwing stop()/write()/setModel() never crashes the server" test covers
all three.

### The actual root cause: a real-time-performance problem, not a bug

The try/catch hardening above didn't fix the user's actual report, which
turned out to be a second, more fundamental issue: enabling HamNoise (in
either CW or voice mode) pinned the server at 100% CPU with **no** error
logged anywhere — not a catchable exception at all, just the server
becoming permanently unresponsive (CI-V control, other WebSocket traffic,
everything sharing that one thread, all starved). That symptom — 100% CPU,
nothing throwing — pointed at the event loop being perpetually busy rather
than stuck or crashed, which led to actually profiling `HamnoiseFilter`'s
real per-chunk cost against the bundled binaries rather than guessing:

- HamNoise's newer "v2" band-split-RNN models (ids 2/3 — what this feature
  originally defaulted to, matching HamNoise's own web app) measured
  **36-53% of the real-time budget per hop of audio**, single-threaded, on
  a fast x86 development machine. A Raspberry Pi's far weaker single-core
  performance pushes that past 100% — the model can't keep up with
  incoming audio at all, each chunk arrives before the last one finishes,
  and the backlog (and CPU usage) only grows. This is exactly the reported
  symptom, and it's structural, not a bug a try/catch can fix: the thread
  is busy computing, not stuck or throwing.
- HamNoise's older "classic" single-GRU models (ids 0/1) measured roughly
  **100x cheaper** on the same hardware (well under 1% per hop) — but
  profiling the FULL `write()` path (resampling + the model call) with
  even these cheap models still showed ~17% of real time per chunk, almost
  all of it in `SincResampler` (this file's windowed-sinc resampler,
  bridging the configured capture rate to/from HamNoise's fixed 9600Hz) —
  specifically, three `Math.sin`/`Math.cos` calls per filter tap per
  output sample, ported essentially verbatim from HamNoise's own
  `denoise-worklet.js`, which is fine on the desktop-class CPU a browser
  AudioWorklet normally runs on but dominates everything else here.

Two fixes followed directly from those numbers, both in
`src/audio/hamnoise-filter.js`:

1. **`quality` now defaults to `'classic'`**, not `'v2'` — see
   `HAMNOISE_QUALITY` in README.md. `'v2'` remains available for anyone
   running this on hardware confirmed fast enough to keep up with it.
2. **`SincResampler` precomputes its windowed-sinc filter weights into a
   lookup table** at construction time (`_weightTable`/`_weightAt()`)
   instead of calling `Math.sin`/`Math.cos` in the hot path, and **the
   filter radii were cut** from HamNoise's original 128 (downsample) /16
   (upsample) taps to 32/8 — this app's actual signal (narrowband CW
   tones and voice/SSB audio) doesn't need anywhere near that steep a
   stopband, and tap count is the resampler's dominant remaining cost
   (profiled directly: linear in radius). Together these measured roughly
   a 5x additional speedup on top of the quality-default change, bringing
   the classic models' full `write()` cost down to ~3-4% of real time per
   chunk on the same development machine — comfortable headroom even
   accounting for a Raspberry Pi's weaker single core.

None of this was reproducible in a cloud/x86 sandbox before being measured
directly — the earlier version of this feature "worked" there because
x86 server-class CPUs have enough raw headroom to mask a cost that a
Raspberry Pi cannot absorb. The lesson generalizes: for anything in this
audio pipeline that runs synchronously on `AudioBridge`'s own thread, per-
chunk CPU cost needs to be checked against the slowest CPU this app
actually ships on, not just "did it run without error somewhere."

## Download package naming ("PiRO.zip")

Per explicit request ("Rename the app to 'PiRO' when creating the
download package"), the distributable zip built from this project is now
named `PiRO.zip`, not `icom-rig-pwa.zip` — this is a packaging-step
naming change only (what the zip file itself is called when handed to
someone), not a rename of the npm package: `package.json`'s own `"name"`
field stays `icom-rig-pwa`, since that's an internal identifier (used in
`require()` paths, `npm install`, etc.) rather than the product's public
name — "PiRO" already was that public name everywhere it's user-visible
(`index.html`'s `<title>`, `SCREEN_TITLE`'s default, the FreeDV Reporter
`version` string above), the zip filename was simply the one place that
hadn't caught up. `INSTALL.md` and `docs/install-debian.md`'s "get the
project onto the machine" steps were updated to `unzip PiRO.zip -d
~/icom-rig-pwa` accordingly (the destination directory name is left
alone — it's just a local folder name the operator picks, not part of
what "the app" is called).

## Known gaps carried over from earlier phases

- **FreeDV Reporter integration is genuinely unverified** — no access to
  the real qso.freedv.org service from wherever this project's code gets
  written/reviewed; see "FreeDV Reporter integration" above's own
  "Genuinely unverified" section. It still never sends an `rx_report`
  (a heard station's callsign/SNR) — an attempt to add manual-entry
  support for this was reverted per explicit request (see "Status
  message (`message_update`)" above's "Reverted" note) — and RADE
  doesn't decode a remote callsign or measure SNR out of the audio
  anywhere in this codebase either way.
- **The RADE codec bridge is genuinely unverified** — no access to the
  real compiled binaries or real radio hardware from wherever this
  project's code gets written/reviewed; see "The RADE codec bridge"
  above's own "Genuinely unverified" section for the full list of what
  that means, including upstream rade_c's own "on-air use is not
  recommended at this stage" caveat for RADE V2 (which is why this bridge
  defaults to V1, opting into V2 only via `RADE_VERSION=v2`).
- **RADE spawns a fresh subprocess chain (including an LPCNet model
  load) on every PTT press/release** rather than keeping one warm across
  a session — see "The RADE codec bridge" above. Whether this introduces
  audible latency on a Raspberry Pi hasn't been measured.
- **No RADE-R / reversed-shift equivalent, and no auto-detection of the
  other station's variant** — the operator has to agree out-of-band which
  variant (and, within RADE, which protocol version) to use, same as any
  other digital mode without an automatic mode-negotiation handshake.
- **RNN noise reduction is genuinely unverified** — no access to a real,
  compiled `rnnoise_demo` binary from wherever this project's code gets
  written/reviewed; see "RNN noise reduction" above's own "Genuinely
  unverified" section for the full list of what that means (framing/
  buffering assumptions, real-world audio-quality effect, and on-device
  resource usage all unconfirmed).

- **No TX/PTT arbitration** (see phases 2-3 notes) — the UI doesn't
  prevent or indicate another client transmitting at the same time. The
  `ptt` event does at least let every connected client see the current
  PTT state (including changes made by others), so simultaneous
  transmission is visible after the fact even though it isn't prevented.
- **Band presets are convenience tuning points, not band-plan authority**
  — see the `BANDS` comment in `app.js`.
- **S-meter is polled** (every 500ms while connected), not pushed, since
  most Icom rigs don't send unsolicited meter updates over CI-V.

## Testing boundary

Everything server-side (control protocol, audio bridge in both codec
modes, scope bridge, static serving) has automated tests with no browser
needed. Client-side, pure-logic pieces that don't touch the DOM/Web Audio
API **are** genuinely tested directly in Node — e.g.
`test/scope-display.test.mjs` executes the real `amplitudeToColor()`
function from `scope.js`. But the DOM/Canvas/AudioWorklet/getUserMedia
code does **not** have automated tests — this sandbox has no headless
browser available, and mocking those APIs convincingly enough to be
worth much is a bigger undertaking than the value it'd add here. All
client files are syntax-checked (as ES modules) and the server was
verified to serve every file correctly with the right content types
(including the new scope markup/canvases), but the actual audio
graph/permissions/gesture flow and the canvas rendering itself need
manual verification in a real browser against real hardware — see the
step-by-step testing guidance already given for earlier phases as a
model for how to approach that.
