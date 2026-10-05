# Audio pipeline notes

Working notes for `src/audio/` and `src/server/audio-bridge.js`.

## Data flow

```
Radio RX audio --USB--> ALSA capture device --arecord--> PcmFramer --> Opus encode --> WS binary broadcast --> clients
Client mic audio --WS binary--> Opus decode --> AlsaPlayback (aplay) --USB--> Radio TX (mic) input
```

## Wire codec: PCM (default) vs Opus

As of phase 5, the browser client speaks raw PCM, not Opus — see
`src/server/audio-bridge.js`'s doc comment for the full reasoning, and
`docs/ui-notes.md` for the client-side consequences. `AUDIO_CODEC=opus`
still works server-side and is covered by tests, but nothing in the
shipped PWA client uses it currently.

## Why child processes instead of a native ALSA binding

There's no ALSA binding for Node that's both well-maintained and doesn't
require compiling native code against `libasound` on the Pi. Shelling out
to `arecord`/`aplay` (raw PCM over stdout/stdin, `-t raw`) avoids that
dependency entirely — both are already present via `alsa-utils`, which is
part of a default Raspberry Pi OS install.

## Why opusscript instead of a native Opus binding

Same reasoning in the other direction: `opusscript` ships libopus
compiled to WASM, so `npm install` needs no C++ toolchain or `libopus-dev`
on the Pi — verified working on both x86 (dev machine) and should behave
identically on ARM since it's WASM, not architecture-specific native code.
If Opus quality/CPU tuning ever becomes a concern, a native binding
(`node-opus` or similar) could be swapped in behind the same `OpusCodec`
interface without touching the rest of the pipeline.

## Framing

Default: 48kHz, mono, 16-bit PCM, 20ms Opus frames (960 samples / 1920
PCM bytes per frame). 20ms is the conventional choice for voice — good
balance of latency and compression efficiency. All three are
configurable via env vars (`AUDIO_SAMPLE_RATE`, `AUDIO_CHANNELS`) if a
given USB codec needs something different — check with `arecord -l` and
test capture manually (`arecord -D plughw:X,0 -f S16_LE -r 48000 -c 1
test.wav`) before assuming 48kHz/mono works for your specific radio.

`PcmFramer` exists because `arecord`'s stdout delivers data in whatever
chunk sizes the OS/pipe buffering happens to produce — never reliably
aligned to Opus frame boundaries — so incoming bytes are accumulated and
sliced into exact frame-sized pieces before encoding.

## Mixer levels on startup

`AudioBridge#start()` best-effort sets every ALSA mixer control on the
USB codec's card to 100% (and unmuted) before starting `arecord`/`aplay`
— see `src/audio/mixer.js`. This exists so input/output gain doesn't get
left wherever a previous session, or the device's power-on default,
happened to leave it.

Deliberately brute-force: rather than targeting specific control names
like "Speaker"/"Mic"/"PCM" (these vary across USB audio codecs — no
single set of names is safe to assume), it enumerates whatever
`amixer -c <card> scontrols` actually reports and sets each one to
`100% unmute`. Controls that don't accept a percentage (e.g. a boolean
"Auto Gain Control" switch) simply fail that one call — logged, not
fatal, and every other control still gets attempted. If `amixer` isn't
installed, or the card has no adjustable controls, this is a no-op and
audio startup proceeds normally either way; nothing about this ever
blocks or fails server startup.

Set `maximizeVolumeOnStart: false` when constructing `AudioBridge` (no
env var exposed for this currently — set it in `src/server/index.js` if
you want it configurable) to skip this and leave the codec's levels as
found, e.g. if you're deliberately running with a lower gain to avoid
clipping and don't want it silently overridden on every restart.

**Worth knowing**: 100% isn't necessarily the *right* level, just a
predictable, repeatable one. Maxing capture gain on the TX (mic) side in
particular risks clipping/distorted audio on transmit if the radio's own
input sensitivity is already reasonably hot — this was requested as a
sensible startup default, not verified against any specific radio's
actual headroom. Worth listening to your own transmitted audio (e.g. via
a second receiver) after enabling this, and reaching for
`maximizeVolumeOnStart: false` plus a manual `amixer` level if it turns
out too hot for your setup.

## Bridges tapping the audio pipeline

`AudioBridge` is the one thing that actually touches ALSA; everything
else that needs to look at (not replace) live audio taps its events
rather than opening its own capture/playback devices:

- **RX audio (raw, pre-filter)**: `capture.on('data', ...)` — the raw
  S16LE PCM chunks `arecord` produces, before any encoding for the wire
  and, critically, before RNNoise (see below). CW/RTTY decoding
  (`src/server/cw-decoder-bridge.js`/`rtty-decoder-bridge.js`), FT8 RX
  (`src/audio/ft8-bridge.js`), and RADE (`src/server/rade-bridge.js`) all
  attach an additional listener directly on this raw event, completely
  independent of whatever RNNoise is doing — see "RNNoise" below for why
  this separation is load-bearing.
- **RX audio (what's actually broadcast/heard)**: `audioBridge.on(
  'rx-pcm', ...)` — added alongside RNNoise (see below); emitted from the
  one internal listener that already decides what to broadcast to
  clients, carrying whichever bytes actually went out: the raw captured
  chunk with RNNoise off, or the filter's own output with it on. A
  listener that needs to hear exactly what the operator hears, rather
  than the raw pre-filter capture, taps here instead of `capture`'s raw
  `'data'` event (mirrors the `'tx-pcm'` pattern below, one direction
  later).
- **TX audio**: `audioBridge.on('tx-pcm', ...)` — emitted right alongside
  (not instead of) the existing `playback.write()` calls in
  `_handleBinaryMessage()`, after Opus decode if `AUDIO_CODEC=opus` is in
  use — so a listener that needs to *observe* the operator's own outgoing
  mic audio (rather than just RX) always gets raw PCM regardless of which
  wire codec is configured, and normal TX playback is completely
  unaffected either way.

RADE (`src/server/rade-bridge.js`) is the one exception that needs more
than observation — it *replaces* RX/TX audio while active, which is what
`setRxMuted()`/`setTxMuted()` exist for (see `AudioBridge`'s own doc
comment).

## RNNoise (the "RNN" toggle, `src/audio/rnnoise-filter.js`)

Sits in the RX signal path between `capture`'s raw `'data'` event and the
`'rx-pcm'` event described above — the one and only place `AudioBridge`
decides what to broadcast to clients (PCM-mode `_wire()`). When the "RNN"
toggle is on, each raw captured chunk is written into a persistent
`rnnoise_demo` child process (spawned lazily, mirroring `RadePipeline`'s
own single-process spawn/pipe shape — see `docs/ui-notes.md`'s "The RADE
codec bridge" for that precedent) instead of being broadcast directly; the filter's own
`'data'` output is what actually gets broadcast and emitted as `'rx-pcm'`.
When off, the raw chunk passes straight through unmodified, exactly as
before this feature existed. See `docs/ui-notes.md`'s "RNN noise
reduction" section for the full user-facing behavior, the `RNNOISE_BIN`
env var, and why this scope (client audio + STT only, never CW/RTTY/FT8/
RADE) is the single most important thing about this feature's design.

## HamNoise (the "HamNoise" toggle, `src/audio/hamnoise-filter.js`)

Sits at the exact same point in the RX signal path as RNNoise above — the
same one-and-only `_wire()` listener that decides what gets broadcast —
and is mutually exclusive with it (`AudioBridge#setHamNoiseEnabled()`/
`#setRnnoiseLevel()` each force the other off; see `audio-bridge.js`'s own
doc comment). Unlike RNNoise's subprocess, `HamnoiseFilter` loads HamNoise's
prebuilt WASM binaries (`models/hamnoise/`) in-process via Node's built-in
`WebAssembly` support and runs as a synchronous chunk-in/chunk-out
transform with no subprocess/FIFO plumbing at all. When the "HamNoise"
toggle is on, each raw captured chunk is written into it instead of being
broadcast directly; its own `'data'` output (resampled back to
`audioBridge.sampleRate`, since the two WASM engines run fixed at 9600Hz
internally) is what actually gets broadcast and emitted as `'rx-pcm'`.
`AudioBridge` also tracks the radio's current mode (via the optional `civ`
constructor option) purely to call `HamnoiseFilter#setModel('cw'|'voice')`
with whichever target matches — see `docs/ui-notes.md`'s "HamNoise noise
reduction" section for the full user-facing behavior and
`models/hamnoise/NOTICE.md` for exactly which upstream files this bundles.

## Known gaps (not addressed in phase 3)

- **No TX arbitration**: every connected client can send TX audio at
  any time; if two clients send simultaneously, both get decoded and
  written to `aplay` with no mixing/priority logic, producing garbled
  audio. A UI-level "who's transmitting" affordance (tied into the
  existing lack of PTT arbitration — see main README) would need to
  solve both problems together, most naturally in phase 5.
- **No jitter buffer**: audio is decoded and played out as soon as it
  arrives. Fine on a well-behaved LAN; would need attention if this
  pipeline is ever run over a lossier/higher-latency link.
- **Single fixed device pair**: `AUDIO_RX_DEVICE`/`AUDIO_TX_DEVICE`
  are set once at startup; no runtime device switching or hot-reload if
  the USB codec is unplugged/replugged (the bridge will emit `audio-error`
  events but won't attempt to recover automatically).
