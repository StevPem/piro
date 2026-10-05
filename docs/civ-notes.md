# CI-V implementation notes

Working notes for the CI-V driver (`src/civ/`). Not user documentation —
just background worth keeping close to the code.

## Frame format

```
FE FE <to> <from> <cmd> [<subCmd>] [<data...>] FD
```

- No byte-stuffing/escaping: CI-V data bytes are BCD-encoded (max 0x99),
  so they never collide with the 0xFE preamble or 0xFD terminator.
- The bus is half-duplex; on USB CI-V links the radio commonly echoes
  back whatever the host writes before sending the real reply. The
  driver discards any frame whose `from` address equals our own
  controller address (default `0xE0`) for this reason.
- Simple "set" commands reply with `FB` (OK) or `FA` (NG), not the
  original command byte. "Read" commands reply with the same command
  byte as the request, populated with data.

## Frequency encoding

Frequencies are little-endian BCD, 5 bytes for values up to 9.999999999
GHz. Example: 14,195,000 Hz -> `00 50 19 14 00`. Verified against
Icom's published CI-V examples and covered by round-trip tests in
`test/frame.test.js`.

## S-meter read (command 0x15, sub-command 0x02) — confirmed against real hardware

`CivDriver#getSMeter()` went through three attempts before landing on
the actual correct decode — worth tracking the full history, since the
first two were both wrong guesses at where in a 2-byte buffer a
"standard" little-endian BCD pair sat, when the real problem was that it
was never that standard encoding at all:

1. **Original bug**: passed the entire `frame.data` buffer to
   `bcdToFreq()` unchecked, assuming a standard BCD pair. Reported as
   S-meter readings inflated into the thousands. Same class of bug
   already found once before for the scope span command — a reply with
   more structure/format than the docs' simple value-range table entry
   implied.
2. **First fix, still wrong**: assumed extra bytes came before the real
   value and kept only the *last* 2 bytes. Reported as the reading stuck
   at 0 regardless of actual signal strength.
3. **Second fix, still a guess**: switched to the *first* 2 bytes,
   reasoned from that symptom but not yet confirmed against real
   hardware — still assumed the standard little-endian BCD pair
   convention used elsewhere in this project (e.g. frequency), just at a
   different offset.
4. **Confirmed correct**, by running `test/manual-smeter-diagnostics.js`
   against real hardware and correlating 20 live raw-byte captures
   directly against the radio's own front-panel S-meter reading (S9 to
   S9+10dB throughout the capture). The actual format is **not** the
   standard byte-pair convention at all:

   ```
   byte[0] & 0x0F  = the hundreds digit (0, 1, or 2 — the full 0-255
                     range never needs more than 3 decimal digits)
   byte[1]         = the tens+ones digits, as a 2-digit BCD byte
   value = 100 * (byte[0] & 0x0F) + BCD(byte[1])
   ```

   Example from the capture: bytes `[0x01, 0x27]` → 100×1 + 27 = 127,
   while the radio's front panel showed S9 — matching this project's
   calibration table (`smeter.js`), which places S9 starting at raw 126.
   All 20 captured readings decoded to 124-144, landing in S8 (2
   borderline readings, right at the threshold — plausible natural
   signal fluctuation) or S9/S9+10dB (18 readings), consistent with what
   was actually observed on the radio throughout.

`test/civ-driver.test.js`'s `testGetSMeter` uses all 20 real captured
byte pairs as regression tests (not synthetic examples), plus checks for
a too-short reply, a hundreds nibble that would push the value past 255,
and — a genuine gap found and fixed while writing this test — a `byte[1]`
that isn't valid BCD, which decodes to `NaN` rather than a number, and
needed an explicit `Number.isFinite()` check since `NaN` comparisons
(`NaN < 0`, `NaN > 255`) are always false and wouldn't have been caught
by the numeric range check alone. The client's polling loop
(`startMeterPolling()` in `app.js`) already catches and retries on any
thrown error, so a still-malformed reply on some other radio/firmware
would show as a stalled meter reading rather than a crash or wrong number.

## SWR read (command 0x15, sub-command 0x12) — reasoned extension, not independently confirmed

`CivDriver#getSWR()` reuses the exact decode logic just confirmed for
S-meter (factored into a shared `_decodeMeterReply()` helper), since SWR
lives under the same command group (`0x15`) and Icom's official manual
documents it in the identical table style. This is a **reasoned
extension based on strong circumstantial evidence, not independent
confirmation** — worth being precise about the difference:

The manual documents three reference examples for this command: `00 00`
= SWR 1.0, `00 48` = SWR 1.5, `00 80` = SWR 2.0, `01 20` = SWR 3.0.
Decoding those exact example bytes with S-meter's confirmed format
(rather than the standard little-endian BCD pair used elsewhere in this
project) gives clean, round raw values: 0, 48, 80, and 120 respectively.
That's a good sign — but unlike S-meter, this hasn't been correlated
against a real radio's actual VSWR reading during transmit into a known
load. If you have a dummy load and an independent SWR reference, that
would be a genuinely useful confirmation to run.

`test/civ-driver.test.js`'s `testGetSWR` uses all four of the manual's
documented examples as regression tests, plus the same defensive checks
`getSMeter()` has (too-short reply, out-of-range decode).

**Displaying it**: `src/client/vswr.js` converts the raw 0-255 value into
an approximate VSWR number via piecewise-linear interpolation between
those same four documented calibration points, extrapolated to a ceiling
of raw 255 = VSWR 5.0 (that endpoint is this project's own choice, not
independently documented — the user's specification was that 5 is the
displayed maximum). Values between calibration points are interpolated,
not independently verified against bench-tested intermediate readings.
`test/vswr.test.mjs` covers the calibration points, interpolation
behavior (including a full monotonicity sweep across all 256 possible
raw values), clamping, and the three color zones.

## Receive filter selection (command 0x06's second byte — no standalone command)

There is no dedicated "select filter" CI-V command. Filter slot (1/2/3)
is the *second* data byte of the mode-set command (`0x06`) — the same
one `setMode()`/`getMode()` already used, which already supported an
optional `filter` parameter from earlier work in this project.
`CivDriver#setFilter(filterNum)` reads the current mode first
(`getMode()`), then resends it unchanged via `setMode(currentMode,
filterNum)` — the mode itself has to be resent alongside the filter
byte every time, there's no way to change just the filter in isolation.
`getFilter()` is a thin convenience over `getMode().filter`. See
`test/civ-driver.test.js`'s `testFilter` for the two-step exchange this
produces (a mode read, then a mode+filter write) verified against a
fake transport.

## DATA MODE (command 0x1A, sub-command 0x05, parameter 0x0063) — real bug found: FT8 TX had no audio path at all

A user reported RX working well but never completing a single FT8 QSO
despite the TX pipeline's sample-generation and PTT-timing having already
been independently verified correct (see docs/ui-notes.md's "Real bug
found: FT8 transmissions were losing their tail to ALSA/pipe latency").
That fix addressed transmission *timing*, but the user's own follow-up
question — "might the transceiver need to be in USB-Data mode to accept
audio input over the USB connection?" — pointed at something more basic:
whether the radio was even listening to this app's audio at all.

It wasn't, most likely. `enterFt8Mode()` (`src/client/app.js`) only ever
called `setMode('USB')` — the *operating* mode. On the IC-7300 (and most
modern Icom rigs), that's a necessary but **not sufficient** condition for
USB-sourced audio to reach the transmitter. The radio has a second,
independent toggle, **DATA MODE**, and — critically — the "MOD Input"
menu setting (Menu > Set > Connectors > MOD Input) that actually selects
*where* TX audio comes from is tracked **separately for DATA MODE OFF vs.
DATA MODE ON**. A stock/typical configuration has DATA-OFF MOD Input set
to the front-panel MIC and DATA-ON MOD Input set to USB — meaning that
without DATA MODE turned on, the radio keeps listening to the mic (or
whatever DATA-OFF is configured to) no matter what this app writes to the
USB audio codec. PTT still keys, a transmission-shaped duration still
elapses, and nothing coherent (if anything at all) reaches the air —
exactly the reported symptom.

**CI-V command**: `1A 05 00 63 <value>` — the address itself is
corroborated by more than one independent source (Icom's own CI-V
reference manual, and other open-source CI-V implementations targeting
the IC-7300 such as Hamlib's icom backend, which uses this exact address
for the same setting). `<value>`: 0 = DATA MODE off, 1 = DATA MODE on
(DATA1 — the only variant this project uses; some Icom models accept 2/3
for DATA2/DATA3, selecting a different filter-specific MOD Input, not
needed here).

This is a "two-part addressed" command in the same style already
established for this project's scope commands (`SCOPE_SUBCMD.MODE`/
`SPAN` — see their own doc comments above): `0x05` isn't itself the final
sub-command, it's a further-addressed group, and the actual setting is
selected by a 2-byte parameter number (`0x00 0x63`) sent as the first two
data bytes. `CivDriver` exposes this as `setDataMode(on)`/`getDataMode()`
in `src/civ/driver.js`; `app.js`'s `enterFt8Mode()`/`exitFt8Mode()` call
`setDataMode(true)`/`setDataMode(false)` alongside the existing
`setMode('USB')` call. See `test/civ-driver.test.js`'s `testDataMode` for
the wire format verified against a fake transport.

### Real hardware confirms the address — but corrects the value's byte width

The paragraph above was written before this was tested against an actual
radio, and it originally assumed `<value>` was a single byte (3 data
bytes total: `[0x00, 0x63, on?1:0]`) — a reasonable-looking guess, but a
guess. A user ran `test/manual-data-mode-diagnostics.js` against a real
IC-7300 and reported back: the SET command (3-byte version) came back OK,
but a follow-up read never showed any change, and — the actual diagnostic
— a bare *read* of this parameter came back as **4 data bytes**,
`[0x00, 0x63, 0x00, 0x01]`, not 3. That's decisive: the value itself is a
**2-byte field** (`[0x00, on?1:0]`), the same "two BCD/digit-packed
bytes for a small numeric value" convention several other Icom `1A 05`
extended parameters use, not the single byte originally assumed. Sending
only 1 byte where the radio expects 2 was accepted at the protocol level
(no NG) but never actually took effect — a genuinely misleading failure
mode, since "OK" strongly implies success with no other signal to the
contrary.

`setDataMode()`/`getDataMode()` have been corrected to send/parse the
full 4-byte structure (`[0x00, 0x63, 0x00, on?1:0]` on write, matching
the read reply's own shape exactly), and `test/civ-driver.test.js`'s
`testDataMode` and `test/manual-data-mode-diagnostics.js` were updated to
match and to exercise the fix directly against real hardware. **The
address (`1A 05 00 63`) and the fact that DATA MODE is genuinely the
right thing to toggle here are now confirmed against real IC-7300
hardware, not just documentation** — what remains unverified is only
whether the actual radio's "MOD Input (DATA ON)" menu setting is USB (see
below), which is a separate, manual, one-time check this app has no way
to perform or verify remotely.

**What this CI-V command still can't do.** It can turn DATA MODE on and
off, but it **cannot** reach into the radio's own menu structure and
change what "MOD Input (DATA ON)" is actually set to — that's a menu
setting with no known CI-V command of its own. If DATA-ON MOD Input on
the actual radio isn't already set to USB, turning DATA MODE on via CI-V
still won't route this app's audio to the transmitter. **Anyone hitting
this same "no successful QSOs" symptom should check, on the radio itself:
Menu > Set > Connectors > MOD Input, with DATA OFF/ON both visible in
that screen — DATA ON needs to read USB.** This is exactly the kind of
one-time physical/menu setup step this project can prompt the CI-V side
of, but can't perform end-to-end on its own — no different in spirit from
needing `arecord -l`/`aplay -l` to find the right ALSA device names once,
by hand, before `AUDIO_RX_DEVICE`/`AUDIO_TX_DEVICE` can be set.

## USB audio levels (command 0x1A, sub-command 0x05, parameters 0x0060 and 0x0065) — maxed at startup, given directly from real hardware

Two more parameters in the same `1A 05` extended-settings sub-group as
DATA MODE above, both genuine continuous 0-255 levels (not on/off):

- **`1A 05 00 60`** — "AF output level to ACC/USB": how loud the radio's
  own RX audio is when it reaches the USB (and ACC) audio output.
- **`1A 05 00 65`** — "MOD input level from USB": how sensitive the radio
  is to audio arriving over USB as a modulation source — i.e. this app's
  own FT8/voice TX audio.

Unlike DATA MODE's address (worked out from documentation/other CI-V
implementations and only confirmed against real hardware after the fact
— see above), both of these addresses and a worked example were given
directly by the operator from a real IC-7300: `1A 05 00 60 02 55` and
`1A 05 00 65 02 55` — setting each to `02 55` (255, the maximum of the
0-255 range). That value's encoding is the "hundreds-digit nibble + BCD
byte" packing already independently hardware-confirmed for S-meter/TX
power/RX gain (see below) — `02` = hundreds digit 2, `55` = BCD tens+ones
55, giving 2×100 + 55 = 255 — not DATA MODE's own plain `[0x00, on?1:0]`
value. `CivDriver#setAfOutputLevelUsb()`/`getAfOutputLevelUsb()` and
`setModInputLevelUsb()`/`getModInputLevelUsb()` implement both, reusing
`_encodeMeterValue()`/`_decodeMeterReply()` for the value field and the
same two-part `[param, param, valueHi, valueLo]` 4-byte structure DATA
MODE already uses for the frame as a whole.

**Why this exists**: the README already documents that this app forces
the USB codec's *ALSA* mixer controls to 100% on every server start
(`AudioBridge`'s `amixer`-based `maximizeVolumeOnStart`, see
`docs/audio-notes.md`) precisely because those levels were observed to
reset unpredictably. These two CI-V settings are the *other* half of the
same audio path — levels the radio itself applies internally, upstream
of what Linux's ALSA layer even sees — so `src/server/index.js` now also
maxes these once at startup (`maximizeUsbAudioLevelsOnRadio()`,
best-effort and non-fatal, same tolerance as the ALSA-side equivalent;
set `CIV_MAXIMIZE_USB_LEVELS=0` to skip it). Between the two, the whole
RX-out and TX-in USB audio chain now starts from a known, maximum,
repeatable level every time, rather than whatever either layer happened
to be left at.

**What's confirmed vs. not.** The two addresses and the `02 55`-for-max
worked example came directly from the operator against a real IC-7300,
which is a stronger starting point than DATA MODE had (that one started
from documentation/Hamlib corroboration alone). What is *not* yet
independently confirmed the way DATA MODE's value-width bug ultimately
was: whether reading these back after a set genuinely reflects what the
radio's own front-panel/menu display shows for these two levels — no
diagnostic script or user report has cross-checked that yet. If a
read-back ever disagrees with the radio's own display, treat it with the
same suspicion DATA MODE's original 3-byte assumption deserved, and see
`test/manual-data-mode-diagnostics.js` for the shape a similar hardware
diagnostic for these two parameters would take.

## Transmit power (command 0x14, sub-command 0x0A) — wrong byte encoding found and fixed on real hardware

`CivDriver#setTxPower(watts)`/`getTxPower()` convert between watts and
the CI-V level's raw 0-255 range via a **simple linear assumption**
(`raw = round(watts / maxWatts * 255)`, `maxWatts` defaulting to 100 —
the IC-7300's rated HF/6m maximum). That linear assumption itself
remains unverified against a real wattmeter or front-panel reading — but
the **byte encoding** was tested on real hardware and found wrong,
worth recording the correction:

1. **First attempt**: this project's standard little-endian BCD pair
   (`freqToBCD`, the same one frequency/RIT use) — reasoned as the most
   defensible default given no evidence either way for this command
   group, but every write was **rejected outright (NG)** on real
   hardware. That's a different, more informative symptom than
   S-meter's original bug (which returned wrong *data* on reads, not an
   outright rejection on writes) — an NG suggests the radio actively
   validates and rejects malformed data, not just misinterprets it.
2. **Root cause, reasoned from the byte values themselves**: for higher
   watt settings, standard BCD puts an invalid byte first. E.g. 100W
   (raw 255) standard-BCD-encodes as `[0x55, 0x02]` — the first byte's
   low nibble is 5, not a valid "hundreds" digit for a 0-255 range
   value (which only ever needs 0, 1, or 2 there). A radio that
   validates this would plausibly reject it outright, exactly matching
   the reported symptom.
3. **Fix**: reuse the exact packing already hardware-confirmed for
   S-meter/SWR instead (hundreds-digit nibble in byte 0, 2-digit BCD in
   byte 1 — see the S-meter section above) via shared
   `_encodeMeterValue()`/`_decodeMeterReply()` helpers. This is a
   well-reasoned correction with a concrete mechanism explaining the
   original failure, but — like the linear watts assumption — it's not
   independently confirmed against real hardware the way S-meter's own
   fix ultimately was (that took correlating real raw-byte captures
   against the front-panel S-meter across many readings; TX power
   hasn't had that same treatment yet).

If this is *still* rejected on your hardware, run
`test/manual-txpower-diagnostics.js` — it tries several candidate
encodings as plain writes and reports which the radio accepts. This is
genuinely **safe to run**: setting the RF power level never engages PTT
and never transmits anything by itself, only actually keying up does
that (front panel, or this app's own PTT button) — the diagnostic never
touches PTT.

`test/civ-driver.test.js`'s `testTxPower` covers all five of the UI's
preset wattages (100/75/50/25/5W), confirms each round-trips exactly
back to the requested watts after the raw-value rounding, and explicitly
checks that the hundreds-digit byte is always a valid 0-2 value —
directly guarding against a regression back to the encoding that caused
the original NG rejection.

## RX gain (command 0x14, sub-command 0x02) — encoding reused from TX power, not independently tested

`CivDriver#setRxGain(value)`/`getRxGain()` control the receiver's RF
gain, raw 0-255 passed straight through with no unit conversion (unlike
`setTxPower()`'s watts scaling — the UI exposes this control as the raw
0-255 range directly, per the person who requested it).

This applies the TX power lesson immediately rather than repeating it:
`RF_GAIN` (`0x02`) lives in the exact same command group as `RF_PWR`
(`0x0A`), both under `CMD.LEVEL` (`0x14`), and TX power's first attempt
at standard little-endian BCD was rejected outright (NG) on real
hardware before switching to the S-meter-style packing (hundreds-digit
nibble + BCD byte). `setRxGain()` and `getRxGain()` use that same
packing from the start. Worth being precise about what that inference
actually rests on, though — it's two layers deep:

1. S-meter's packing is hardware-confirmed (real correlated byte
   captures against the front-panel S-meter).
2. TX power's *switch* to that same packing is a reasoned fix for a real
   NG rejection, but hasn't itself been confirmed by real hardware
   testing to have resolved it.
3. RX gain assumes it shares TX power's encoding because they're
   siblings in the same command group — reasonable, but its own
   independent layer of inference on top of the other two.

If RX gain doesn't behave as expected on real hardware, the same
diagnostic methodology that resolved earlier bugs in this project
applies here too: try candidate encodings as plain writes (this is safe
— setting a level never engages PTT) and correlate against what the
radio's own front panel actually shows.

`test/civ-driver.test.js`'s `testRxGain` covers the full 0-255 range
including both endpoints, confirms out-of-range input is clamped rather
than sent as garbage, and exercises the read path.

## CW pitch (command 0x14, sub-command 0x09) — verified against the manual's exact examples

`CivDriver#getCwPitch()` reads the radio's configured CW pitch
(sidetone/RX filter center frequency), converting the raw 0-255 value to
Hz. Unlike RX gain/TX power, this one has a real advantage: Icom's
manual gives three explicit worked examples for this exact field (raw
`0000`/`0128`/`0255` -> `300`/`600`/`900`Hz), so the conversion is
checked directly against real documented data rather than inferred by
analogy — `test/civ-driver.test.js`'s `testCwPitch` verifies all three
points exactly. The obvious linear formula (`300 + raw * 600 / 255`,
rounded) is off by 1Hz at the middle example (601 vs the documented
600); fixed by snapping to the manual's own stated 5Hz step grid
(`round((300 + raw * 600/255) / 5) * 5`), which matches all three points
exactly. A 1Hz discrepancy would have been immaterial for this field's
actual use (tuning a Goertzel tone detector — see below), but getting it
exactly right where real reference data exists to check against was
easy enough not to skip.

Used automatically by the CW decoder (below) to tune its tone detector
to whatever the radio's actually configured for, rather than requiring
a separately-maintained setting that could drift out of sync with the
radio's own menu.

## CW decoder — tone detection, adaptive timing, real bugs found and fixed via synthetic audio testing

`src/audio/cw-decoder.js` decodes Morse code from the radio's own RX
audio: a Goertzel tone detector (cheaper than a full FFT for watching
one frequency) finds the CW pitch, an adaptive noise floor separates
tone from silence without needing a fixed absolute threshold, mark/space
durations get classified as dot/dash/gaps relative to an adaptive
running estimate of the operator's actual keying speed, and a lookup
table turns the resulting dot/dash sequences into text.

This was built by feeding it synthetic generated audio and iterating
against real, observed failures — not written once and assumed correct.
Four real bugs found this way, worth recording:

1. **Cold-start bug**: the noise floor originally only initialized after
   observing an explicit "no tone" block. Audio starting mid-mark with
   no leading silence at all (a real scenario — the decoder engaging
   while someone's already transmitting) had its entire first character
   silently misread as silence and dropped. Fixed by starting from a
   conservative low guess instead of requiring a prior observation.
2. **Wrong-direction speed adaptation**: a sudden large speed increase —
   the common CW practice of sending a callsign slowly, then speeding up
   for the rest of a call — made the original "only dots update the
   estimate" exponential average diverge the *wrong* way: a genuinely
   fast dash got misclassified as a slow dot against the stale
   threshold, pulling the estimate further off in the wrong direction.
   Fixed with a sliding-window-minimum approach (the unit estimate
   re-derives from the shortest of the last several marks, dot or dash)
   that recovers correctly after just the first character of a 15->25
   WPM jump.
3. **Noise-vs-speed-range tension**: tuning threshold/block-size
   parameters against synthetic noisy audio (~5:1 SNR) found a real
   tradeoff, not just a bug to fix — widening the analysis block reduced
   false-positive noise spikes but broke decoding at faster speeds
   entirely (empty output for a clean 35 WPM signal, since the blocks
   became too coarse relative to a fast dot's duration). The shorter
   block size that correctly handles the full realistic CW speed range
   was kept, which means decoding under noise is not uniformly reliable
   across every noise realization — see `test/cw-decoder.test.js` for
   exactly which fixed-seed noise cases decode cleanly, which are
   expected to have only the first character wrong (the noise floor
   needs a brief moment to calibrate to the actual noise level once real
   audio starts, the same way a human ear or a radio's AGC needs a
   moment to settle into a noisy signal), and one case that's
   acknowledged to degrade further under this tuning.
4. **Dash-seeds-the-unit-estimate bug**: found from a fresh "not
   reliably decoding any messages" report, and reproduced with plain
   clean synthetic audio — no noise needed at all, purely algorithmic.
   The sliding-window-minimum approach from bug #2 above let *any*
   classified mark — dot or dash alike — seed or update the window, on
   the assumption its minimum would always settle on the true dot
   length. That assumption breaks while the window hasn't yet seen a
   single real dot: a dash seeding it directly (most likely right at the
   very start of a message) drags the estimate up toward a dash's
   length instead, so every dash immediately after reads as too few
   units and misreads as a dot. "CQ" (`-.-. --.-`) — the single most
   common CW call there is — decoded as "BQ" on every trial; "0700 UTC"
   (`0` is `-----`) decoded as a lone "?". Fixed by only letting marks
   actually *classified as dots* seed the window; a dash never seeds it,
   cold-start or not. This doesn't reopen bug #2's fix: that recovery
   depends on a now-fast dash being classified `isDash: false` (i.e.
   read as a dot) against the stale slow estimate at the moment it's
   checked, so it's still let through under the new rule. See
   `docs/ui-notes.md`'s CW decoder section for the full account and
   `test/cw-decoder.test.js` for the regression tests.

Deliberately scoped to letters, digits, and common punctuation for v1 —
no prosigns (`<SK>`, `<AR>`, etc.), since several share dot/dash patterns
with punctuation already in the table (`<AR>` and `+` are both `.-.-.`)
and resolving that cleanly is more complexity than this version needs.

## PTT fail-safe watchdog — 10-minute automatic transmission cutoff

`ControlServer` (`src/server/ws-server.js`) enforces a 10-minute
fail-safe cutoff on transmission, required for this style of
remote-controlled operation under the Australian amateur class licence
(`Radiocommunications (Amateur Stations) Class Licence 2023`, s.13(4)(b)
— a station operated without anyone physically present must be "fitted
with a timer that causes automatic shutdown of the station if a
malfunction causes an unintended transmission that lasts longer than 10
minutes").

**Deliberately server-side, not client-side.** The server is the
persistent process — if a browser tab crashes or the network drops
while transmitting, a client-side timer would never fire, which is
exactly the "control link malfunction" scenario the rule exists to
guard against. `setPtt(true)` arms a timer (`pttWatchdogMs`, default
`10 * 60 * 1000`, overridable via the `ControlServer` constructor
specifically so tests don't have to wait 10 real minutes — see
`test/ws-server.test.js`); any transition back to PTT-off — a normal
release, the watchdog itself firing, or anything else — clears it. If
the timer elapses first, the server force-calls `civ.setPtt(false)`
directly (not relying on any client to do it), updates cached state, and
broadcasts a `ptt-timeout` event followed by the normal `ptt` event to
every connected client, so all of them see the forced release and the
reason for it, not just the one that originally kicked off the
transmission.

**Why normal CW keying can never trip this.** The watchdog measures one
continuous, unbroken transmission — every PTT-off resets it. Since CW
keying (see below) naturally toggles PTT off between every dot and dash,
even a very long keying session accumulates zero continuous time toward
the 10-minute limit. This is deliberate and tested
(`test/ws-server.test.js` sends rapid on/off toggling spanning longer
than the configured watchdog window and confirms no timeout fires) — but
it does leave one gap: a genuinely *stuck* paddle producing continuous
keying for the full 10 minutes wouldn't hit this particular backstop the
same way a held voice PTT would, since each element's brief off-period
keeps resetting it. `app.js`'s keyer loop closes that specific gap with
its own client-side session-length check — see docs/ui-notes.md.

**Known limitation**: the timer is in-memory and not persisted, so a
server process crash or restart mid-transmission loses it, and a fresh
process starts assuming PTT is off regardless of the radio's actual
state. This is an accepted gap, not an oversight — it's orthogonal to
what the rule is actually guarding against (control-link malfunctions,
not infrastructure crashes), and solving every conceivable failure mode
here would be well beyond what a software watchdog can reasonably promise.

## Known CI-V addresses

| Model    | Address |
|----------|---------|
| IC-7300  | 0x94    |
| IC-7610  | 0x98    |
| IC-9700  | 0xA2    |
| IC-705   | 0xA4    |
| IC-7100  | 0x88    |
| IC-7850/7851 | 0x8E |

Always confirm against the radio's menu (`SET > Connectors > CI-V`) —
these are defaults and can be changed by the user. `CivDriver.detectRadioAddress()`
queries the broadcast address (`0x00`) and reads back whichever address
replies; only reliable with a single radio on the bus, and can also fail
for unrelated reasons (baud rate mismatch, CI-V Transceive disabled on
the radio, etc.) — it's a convenience, not a requirement. Every
`test/manual-*.js` script that uses it accepts the address as an
explicit second CLI argument instead (e.g.
`node test/manual-smeter-diagnostics.js /dev/ttyUSB0 0x94`), and now
fails with a clear message pointing at that workaround rather than a raw
stack trace if auto-detection doesn't work on your setup.

**A serial port can only be held open by one process at a time.** Running
any `test/manual-*.js` script while the main server (`npm start`) is
also connected to the same device produces two independent CI-V
controllers writing to the same bus — this showed up in practice as
*every single request timing out with no reply at all*, a distinctly
different symptom from a decoding bug (which still gets a reply, just
with the wrong bytes). `manual-smeter-diagnostics.js` now detects three
consecutive timeouts specifically and prints this as the likely
explanation rather than letting the run continue timing out silently for
its full read count. Stop the server before running any of these
scripts.

**A baud rate mismatch produces the exact same symptom** (every request
timing out, no reply) and is just as easy to overlook. `manual-scope-test.js`
and `manual-civ-test.js` have always supported the `CIV_BAUD_RATE` env
var for this; `manual-smeter-diagnostics.js` and
`manual-scope-span-diagnostics.js` (both added later, in this same
project) missed carrying that pattern forward and silently defaulted to
19200 baud with no way to override — a real gap, since a radio configured
for a different rate (115200 is common for scope work — see below) would
never be able to communicate with either of those two scripts at all,
independent of anything else being investigated. All four scripts now
support `CIV_BAUD_RATE` consistently and print the effective baud rate
they're using at startup, so this is visible rather than silent.

## Baud rate

Defaults to 19200 (`CivDriver`'s constructor default), which must match
the radio's own **CI-V USB Baud Rate** menu setting exactly — a mismatch
here doesn't produce a clean error, it just fails to establish
communication at all (garbled/no framing), which looks identical to a
wrong serial path or address. Override via `CIV_BAUD_RATE` (server) or
the same env var with the manual test scripts. Spectrum scope data is
high-volume enough that some setups need a higher rate — 115200 is a
common choice — see "Spectrum scope" below.

## Deliberately deferred

- **Hamlib interop** — not used; this driver talks CI-V directly to
  keep the Pi-side app a single self-contained process.

## RX function toggles (command 0x16)

`CMD.FUNCTION` (0x16) covers a family of simple RX function toggles.
`FUNCTION_SUBCMD` in `commands.js` currently defines:

- `02` — Preamp: `00`=OFF, `01`=Preamp 1 ON, `02`=Preamp 2 ON
- `22` — Noise blanker: `00`/`01`
- `40` — Noise reduction: `00`/`01`
- `41` — Auto notch: `00`/`01`
- `48` — Manual notch: `00`/`01` (available, not currently used by the UI)

All confirmed against Icom's official IC-7300 CI-V reference manual
(Section 19) as genuinely simple single-byte values — each is listed in
the command table as plain `00/01` (or, for Preamp, `00 to 02`) with no
`p.19-XX` page reference, which — per the same rule that correctly
distinguished 1-byte from 2-byte scope sub-commands (see below) — means
no `[0x00, value]` prefix structure is needed here, unlike some other
commands under different groups in this same command family.

**Notch maps to auto notch (`41`), not manual notch (`48`).** Both are
genuine on/off toggles per the manual, but manual notch only does
anything once the NOTCH knob is also turned — auto notch is a passive
toggle that works on its own, closer to how NR/NB/Preamp behave. This is
a judgment call, not something the manual states outright as the
"correct" choice for a generic "Notch" label; `FUNCTION_SUBCMD.MANUAL_NOTCH`
remains available if the other interpretation is actually wanted.

`CivDriver#setPreamp(value)`, `#setNoiseReduction(on)`,
`#setNoiseBlanker(on)`, and `#setNotch(on)` wrap these — see
`test/civ-driver.test.js`'s `testFunctionToggles` for the wire-level
verification against a fake transport.

**Read-back**: `#getPreamp()`, `#getNoiseReduction()`, `#getNoiseBlanker()`,
and `#getNotch()` read the actual current value the same way
`getScopeSpan()` does — a bare read request (command+subcommand, no data
bytes) — via a small shared helper, `_readSingleByteSetting()`, since all
four are otherwise identical single-byte reads. These exist specifically
because none of these settings are pushed unsolicited over CI-V the way
frequency/mode are (no "transceive" equivalent for them), so a client has
no way to notice a front-panel change without actively asking — see
`docs/ui-notes.md` for how the UI polls these periodically to stay
genuinely in sync rather than just reflecting its own last request.

## Antenna tuner (command 0x1C, sub-command 0x01)

Lives under the same command group (`0x1C`) as PTT (sub-command `0x00`)
— `SUBCMD.TUNER` (`0x01`) in `commands.js`. Confirmed against the same
official manual, listed as `00 to 02` with no page reference (the same
"simple single-byte value" signal used throughout this project):

- `00` — tuner OFF
- `01` — tuner ON
- `02` — start tuning now

Unlike the function toggles above, `02` is a **one-shot trigger, not a
persistent state** — the radio runs its tune cycle and settles back to
ON or OFF once done, it doesn't keep reporting "2". `CivDriver#setTuner(value)`
is the single entry point for all three; the UI exposes it as two
separate controls — an on/off toggle button and a separate "Tune" button
that always sends `2` — since they're conceptually different actions
even though they share one CI-V command. See
`test/civ-driver.test.js`'s `testSetTuner` for the wire-level
verification, including the exact frame for the tune-now trigger
(`FE FE 94 E0 1C 01 02 FD`).

`#getTuner()` reads the actual current value back (via the same
`_readSingleByteSetting()` helper) — realistically only ever `0` or `1`,
since `2` is a momentary trigger the radio doesn't hold as a reportable
state, but the raw byte is returned as-is (not coerced to boolean) in
case some firmware ever does report it.

## Spectrum scope (command 0x27)

Implemented in `src/civ/scope.js` (decode/reassembly) and wired into
`CivDriver` (`enableScopeOutput()`/`disableScopeOutput()`, `'scope-line'`
event). See the doc comment at the top of `scope.js` for the full byte
layout; summary:

- `27 10` (data `00`/`01`) — the radio's own scope display on/off
- `27 11` (data `00`/`01`) — whether waveform data is sent to the
  controller at all (this is the one that actually matters for us)
- `27 14` (data `00`/`01`/`02`/`03`) — scope mode: Center/Fixed/Scroll-C/Scroll-F.
  `CivDriver#setScopeMode()`.
- `27 15` — Center/Scroll-C mode span. **Not a freely settable Hz
  value** — the radio only accepts one of 8 fixed presets
  (`SCOPE_SPAN_PRESETS_HZ` in `commands.js`: 2500/5000/10000/25000/
  50000/100000/250000/500000 Hz). `CivDriver#setScopeSpan()` rounds up
  to the nearest preset that covers the requested width and returns
  what was actually applied.

  **This command's wire format has been genuinely difficult to pin
  down**, worth being honest about the full history since most of it
  was driven by real hardware testing, not just documentation review —
  and the most recent source, unlike every prior one, is Icom's own
  official IC-7300 CI-V reference manual (Section 19), which meaningfully
  changes the confidence level here:
  1. First guess: a single fixed byte offset for a 2-byte, /100-scaled
     BCD value within a 6-byte payload, reasoned from a garbled
     digit-position description — wrong (scope kept showing a much
     wider range than requested).
  2. Required read-back confirmation of each candidate offset —
     categorically worse: the radio doesn't support reading this back
     in the assumed format, so every attempt timed out (up to 1s each),
     blocking the first call for 5+ seconds during server startup,
     which delayed everything after it, audio included.
  3. Dropped read-back, accepted the first offset that wasn't NG'd —
     fast, but still wrong in a way NG-checking can't catch: the radio
     accepts malformed 6-byte payloads without deep validation.
  4. A concrete worked example from an informal online source
     (`27 15 05` → "±100kHz") checked out byte-for-byte against a
     *different* claim: that the value is a single-byte *index* (0-7)
     into the 8 presets, each labeled by its **half**-width. This
     seemed well-verified (the source's SET example and READ example
     were internally consistent), but real hardware testing showed the
     radio rejected (NG) this single-byte-index write outright — even
     when triggered well after startup, ruling out a timing explanation.
  5. **Current version, grounded in Icom's own official manual** (a
     genuine upgrade in source authority over every prior attempt,
     which all relied on third-party aggregations, forum posts, or
     digit-position diagrams from less certain provenance): the
     manual's own "Scope span settings" reference table
     (`p.19-14`) explicitly lists the preset values as **2.5/5/10/25/
     50/100/250/500 kHz directly** — confirming the value is the span
     itself in Hz, not an index, and not a half-width needing doubling
     (attempt 4's source was wrong on both counts). The exact byte
     *position* within the 6-byte payload isn't as unambiguous — PDF
     extraction of a diagram with arrows from labels into nibble
     positions is inherently lossy — so this was derived instead by
     cross-validating the manual's own digit-label ordering against
     *two* commands this project has already hardware-verified (the
     main frequency field, and the RIT frequency field, both matching
     this project's existing little-endian `freqToBCD`/`bcdToFreq`
     convention exactly). The resulting implementation: a fixed `0x00`
     prefix byte followed by `freqToBCD(value, 5)` — reusing the exact
     same, already hardware-proven 5-byte frequency encoder, just for a
     narrower value range. This is a well-reasoned primary hypothesis,
     not an independently confirmed worked example the way the main
     frequency field was — `test/manual-scope-span-diagnostics.js` has
     been updated with this as its primary candidate, plus a few
     alternate byte placements, for final confirmation against real
     hardware.
  6. The manual also revealed a **separate, related bug**: scope
     *mode*-setting (`27 14`) needs a 2-byte payload (`[0x00,
     modeValue]`, confirmed by the same manual, p.19-14), not the
     1-byte payload this project had been sending. This wasn't causing
     visible failures (the radio appears to tolerate the shorter
     payload without rejecting it, defaulting the missing byte), but is
     now corrected to match the documented format exactly. The enable
     commands (`27 10`/`27 11`) are confirmed to genuinely be 1-byte —
     the manual lists their data as plain `00/01` directly in the
     command table with no page reference, unlike every command (14,
     15, 17, 1A, ...) that needs a detailed diagram and turns out to
     have this 2-byte structure.

  See `CivDriver#setScopeSpan()`, `#getScopeSpan()`, and
  `#setScopeMode()`'s doc comments for the current implementation, and
  `test/civ-driver.test.js` (`testScopeSpanWireFormat`, `testGetScopeSpan`,
  `testGetScopeSpanUnsupportedReply`) for what's verified against a fake
  transport.

  7. **The value sent/read on the wire is still exactly the preset in
     Hz (unchanged from point 5 above), but real on-air testing revealed
     what that value means for the *displayed* range**: it's the width
     to each side of center, not the total displayed width. Tuned to
     7100kHz with the "100kHz" preset applied, the scope actually sweeps
     7.000-7.200MHz (±100kHz), not 7.050-7.150MHz. This doesn't change
     `setScopeSpan()`/the `27 15` wire format at all — the same preset
     value (e.g. `100000`) is still requested for a "100kHz" selection,
     confirmed correct against the manual. It only affects how the
     *client* turns the `span` field echoed back in the `27 00` waveform
     header (see below) into an on-screen `[lo, hi]` range — see
     `docs/ui-notes.md`'s "Scope span selection" section for the client
     fix (`ScopeDisplay#pushLine()`).
- `27 00` — the waveform data itself; once both of the above are on,
  the radio pushes this **unsolicited**, repeatedly (Icom's own docs
  cite 5-10Hz over USB), split into up to 11 chunks per "line". The
  first chunk (sequence 1) carries mode + frequency-range info but no
  samples; later chunks carry pure sample bytes, one byte per pixel.
  `ScopeLineAssembler` buffers by sequence number and emits a complete
  `'scope-line'` once every chunk in that line has arrived.

### Keeping the scope centered on the current frequency

The scope stays centered on whatever frequency is tuned via
`ScopeBridge#start()` calling `CivDriver#setScopeMode(SCOPE_MODE.CENTER)`
**once**, when scope output is enabled — nothing more. Center mode's
displayed center always tracks the current VFO frequency automatically,
on the radio itself, so this one cheap, simple command is enough to stay
centered through every subsequent change — band clicks, direct entry,
scope click-to-tune, even the front panel.

**Span is deliberately not set automatically at startup**, and stays that
way even with the newly-corrected wire format above — this decision was
made when the *previous* (now known wrong) format caused two different
real failures at startup (one a multi-second delay, one an outright NG
rejection with unconfirmed root cause), and there's no reason to
re-introduce that risk to the critical startup path just because the
format is now better-grounded — it still isn't independently
hardware-confirmed the way frequency encoding is. `app.js` requests a
default span itself once the client is already connected — happening
naturally later, well after server startup has already succeeded — and
its "Scope Span" slider (eight positions, one per preset) lets it be
changed on demand after that, the same way. A failure in either case only affects that one request
(shown as an error toast client-side); it can never affect server
startup, audio, or anything else.

If the span still doesn't visibly change after this correction, run
`test/manual-scope-span-diagnostics.js` — it now tests the manual-derived
primary hypothesis first, plus a few alternate byte placements, and
checks each one against live `scope-line` broadcasts (independently
trusted — see the driver test suite) rather than just whether the radio
replied OK. Share the full output if you open an issue about this.

Deliberately **not** using Fixed mode with custom edges (`27 1E`) even
though that command has no span-size ceiling: setting a custom edge
requires first picking the correct one of 13 model-specific "frequency
range group" indices from a table only confirmed for the IC-7300 (no
verified table for IC-9700/IC-7610/etc), a real risk of sending a
wrong/rejected command on other models. Center+Span reuses this
project's already-verified BCD encoding and has no such per-model lookup
table.

`CivDriver#tuneScopeToRange(lowHz, highHz)` (switches to Center mode and
sets the span to the smallest preset that covers `highHz - lowHz`) and
`CivDriver#centerScope(spanHz)` (mode + a fixed span in one call, used by
the WebSocket `setScopeSpan` and `setScopeBand` requests — but, as above,
not by `ScopeBridge#start()` itself) remain the two entry points for
setting mode+span together.

### Real-world reliability — read before relying on this

Icom's documentation describes this cleanly, but it does **not**
reliably work in practice for everyone. Multiple people on the wfview
project's forum (probably the most serious open-source implementation of
exactly this) report sending the documented enable commands on an
IC-7300 over its USB CI-V port and getting no waveform data back, despite
confirming via a USB sniffer that the radio *is* sending scope data
somewhere on the USB connection — just seemingly not reachable the same
way as ordinary CI-V commands in every case. See:

- <https://forum.wfview.org/t/waveform-data-via-ci-v-bus-interface/3092>
- <https://forum.wfview.org/t/access-to-waveform-data-by-code/3085>

Given this, `test/manual-scope-test.js` exists specifically to let you
confirm actual data arrives on **your** radio/firmware/connection before
any further work goes into broadcasting or rendering it — run that first.
If it reports zero lines received, that's a genuine hardware/firmware
limitation to work around (troubleshooting suggestions are printed by the
script itself), not a bug in this driver's decoding logic (which is unit
tested against synthetic frames matching the documented format in
`test/scope.test.js`, independent of whether any given radio actually
sends real ones).

## A driver bug found while adding scope support

The request/reply matcher (`_frameMatchesCurrent` in `driver.js`)
originally matched pending requests by command byte only. This was fine
while every multi-subcommand family (`0x1A`, `0x15`, etc.) was only ever
used for infrequent request/reply pairs — but scope waveform data shares
command byte `0x27` with the on/off and data-output commands, and once
enabled, pushes unsolicited frames continuously. A pending request for,
say, "read scope on/off status" (`27 10`) could have been incorrectly
resolved by an unrelated, fast-arriving `27 00` waveform push, silently
corrupting both the request's result and dropping the waveform data.
Fixed by also checking `subCmd` when the pending request specified one;
regression-tested in `test/civ-driver.test.js`. Worth remembering if any
future command family gets added that mixes occasional requests with
frequent unsolicited pushes on the same command byte.
