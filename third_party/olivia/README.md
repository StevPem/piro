# Olivia (from fldigi)

Olivia is an MFSK keyboard-to-keyboard mode designed by Pawel Jalocha,
SP9VRC, in 2003. PiRO sends and receives the 8-tone, 250 Hz variant
("Olivia 8/250") in pure JavaScript, compatible with fldigi, with no fldigi
binaries involved.

| | |
|---|---|
| Upstream | fldigi, `master` (version 4.1.23, commit `61b97f4`), https://github.com/w1hkj/fldigi |
| Upstream licence | GNU GPL version 3 (`COPYING` in the fldigi tree) |
| PiRO licence | AGPL-3.0-only (GPL-3.0 section 13 permits combining the two) |
| Copyright | Pawel Jalocha (the MFSK/Olivia code, 1999-2004), David Freese W1HKJ and the fldigi contributors |

## What was ported

| PiRO file | fldigi source |
|---|---|
| `src/audio/olivia-dsp.js` | `src/include/jalocha/pj_fht.h` (fast Hadamard transform), `pj_gray.h`, `pj_fft.h` (`r2FFT`, including the two-real-signals helpers), `pj_lowpass3.h`, the `RateConverter` class in `pj_mfsk.h`, and the parameter calculations in `MFSK_Transmitter::Preset` / `MFSK_Receiver::Preset` and `src/olivia/olivia.cxx` |
| `src/audio/olivia-tx.js` | `MFSK_Encoder`, `MFSK_Modulator` and `MFSK_Transmitter` in `pj_mfsk.h`; the transmit sequence of `olivia::tx_process()` and `send_tones()` in `src/olivia/olivia.cxx` (start tones, one NUL, the text, stop tones; 8-bit escape) |
| `src/audio/olivia-rx.js` | `MFSK_InputProcessor`, `MFSK_Demodulator`, `MFSK_SoftDecoder` and `MFSK_Receiver` in `pj_mfsk.h`; `olivia::unescape()` and the character filter in `olivia::rx_process()` |
| `src/audio/olivia-decode-worker.js`, `src/server/olivia-decoder-bridge.js` | PiRO's own glue: 48 kHz to 8 kHz decimation, a worker thread, the audio spectrum |

Settings are fldigi's defaults for Olivia 8/250: 8 kHz internal sample rate,
tune margin 8 (+/-125 Hz), integration 4 blocks, start/stop tones on, 8-bit
characters on. The modem code supports the other Olivia variants (2 to 256
tones, 125 to 2000 Hz) through `oliviaParams()`, but only 8/250 is offered in
the UI and covered by the tests. Contestia (a close relative with a
different scrambling code and 6-bit characters) is not ported.

## Differences from fldigi

* **Junk filtering** (`OliviaReceiver` options `blockSnrMin`, default 4.5,
  and `dropControlBlocks`, default on). fldigi only checks the synchroniser's
  S/N, which is averaged over four blocks, so with its squelch off it prints
  junk for a block or two before and after every transmission and about 59
  characters a minute on plain noise. PiRO also requires each block's own
  S/N to be at least `blockSnrMin` and drops blocks containing control codes
  that text never uses. In testing: no false characters in 1000 s of noise,
  and no loss of copy at -14 dB S/N. `OLIVIA_SQUELCH=off` turns both off.
* **A noise-reference read past the end of an array.** In
  `MFSK_Receiver::ProcessSymbol`, the noise used for the S/N figure is read
  through a pointer that has just walked past the current row, so it lands
  on the next block phase's first frequency offset, and for the last block
  phase on memory past the end of the array. PiRO keeps the in-range
  behaviour (so the S/N figures match) and wraps the out-of-range case to the
  start of the array. This only affects junk near-ties, never decoded text.
* **Phase steps.** fldigi picks the +/-90 degree phase step between symbols
  with `rand()`. PiRO uses `Math.random()` on air and a seeded generator in
  tests, so the reference audio can be reproduced sample for sample.

## How the port is checked

`third_party/olivia/olivia_ref.cpp` is a small program that drives fldigi's own
`MFSK_Transmitter` and `MFSK_Receiver` exactly as `olivia.cxx` does, with
`rand()` replaced by the same seeded generator the JS tests use. Build it
against fldigi's headers:

```bash
git clone --depth 1 https://github.com/w1hkj/fldigi
g++ -O2 -std=c++14 -w -I fldigi/src/include/jalocha -o olivia_ref third_party/olivia/olivia_ref.cpp
node third_party/olivia/make-fixtures.js ./olivia_ref
```

That regenerates `test/fixtures/olivia-vectors.json` and
`test/fixtures/olivia-k-1000hz.i16`, which `test/olivia.test.js` checks:

* **160 messages** (empty, one to three characters, every 7-bit code, high
  bytes, and random QSO text at random centre frequencies from 400 to
  2600 Hz): the complete symbol sequence must match the reference exactly.
* **One reference waveform** ("K" at 1000 Hz): matches to 1 LSB. In practice
  the JS output was identical to the reference's float32 output for every
  message tried.
* **Seven receive cases** (clean, 60 and 110 Hz off tune, noisy, low and high
  in the band), decoded by the reference receiver: the JS receiver, with
  PiRO's additions off, decodes the same text and reports the same S/N and
  frequency offset.

Further tests cover PiRO's receiver defaults (no junk around messages or on
noise, full copy at -13 dB, the +/-125 Hz tuning range, a partly overlapping
neighbour, chunk-size invariance) and the 48 kHz audio path through the
resampler and decimator. `test/olivia-decoder-bridge.test.js` runs the real
worker end to end.

## Caveats

Not yet tested over the air. The receiver, like fldigi's, listens at one
centre frequency (+/-125 Hz) rather than across the whole passband, and
prints text about four blocks (8 s) after it was sent.
