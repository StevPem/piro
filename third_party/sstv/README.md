# SSTV receiver (from slowrx)

PiRO's SSTV receiver is a JavaScript port of slowrx, Oona Räisänen's SSTV
decoder for Linux. No slowrx binaries are involved.

| | |
|---|---|
| Upstream | slowrx, `master` (commit `ca6d701`, July 2024), https://github.com/windytan/slowrx |
| Upstream licence | ISC (`COPYING` in the slowrx tree) |
| PiRO licence | AGPL-3.0-only (the ISC licence permits this; its notice is kept below) |
| Copyright | (c) 2007-2013, Oona Räisänen (OH2EIQ) |

## What was ported

| PiRO file | slowrx source |
|---|---|
| `src/audio/sstv-modes.js` | `modespec.c` (the 25 mode specifications and the VIS code map) and the channel layout, pixel timing and colour conversion in `GetVideo()` (`video.c`) |
| `src/audio/sstv-rx.js` | `GetVIS()` (`vis.c`): header detection and frequency shift; `GetVideo()` (`video.c`): sync detection, S/N estimate, adaptive-window frequency estimate, pixel read-out; `FindSync()` (`sync.c`): Hough-transform slant correction and sync-edge phase; the sequence in `Listen()` (`slowrx.c`) |
| `src/audio/sstv-tx.js` | not from slowrx: PiRO's own encoder (pictures, FSK ID, CW ID), used for transmitting and by the tests; timings from N7CXI's specification |
| FSK ID in `src/audio/sstv-rx.js` | `GetFSK()` (`fsk.c`): the callsign burst after a picture |
| `src/audio/sstv-decode-worker.js`, `src/server/sstv-decoder-bridge.js`, `src/server/png.js` | PiRO's own glue: 48 kHz to 12 kHz decimation, a worker thread, line frames and PNG pictures to the browser |

slowrx's GTK interface, sound-card code and manual re-sync controls are
not ported.

## Differences from slowrx

* **12 kHz instead of 44.1 kHz.** Every length in samples is scaled: the
  1024-point video FFT becomes a 279-point DFT (the same 43 Hz bins), the
  2048-point header FFT a 557-point one (21.5 Hz), the adaptive Hann
  windows 13 to 279 samples instead of 48 to 1024, the frequency estimate
  every 2 samples instead of 6, the sync test every 4 instead of 13, the
  S/N estimate every 70 instead of 256. Only the bins slowrx actually looks
  at are computed (a direct DFT), which is cheaper than its full FFTs.
* **Streaming.** slowrx reads the sound card in its own loops; here the
  same steps run sample by sample on whatever audio arrives, with a short
  look-ahead for the centred windows.
* **Robot 72.** slowrx gives all three channels 92 ms. N7CXI's mode
  specification (the reference slowrx cites) has Y 138 ms and R-Y and B-Y
  69 ms each, each chroma channel after a 4.5 ms separator and 1.5 ms porch.
  PiRO uses the specification. (Robot 36, whose chroma lines alternate, was
  already right.)
* **Horizontal position (sync phase).** slowrx assumes the sync pulse starts
  each line, with an approximate correction for Scottie (whose sync is in
  the middle); PiRO places the sync from the mode's own line layout, which
  is exact for every mode. slowrx also builds its slant image over all
  picture lines for the PD modes, which send two lines per sync pulse; PiRO
  uses the number of sync periods.
* **Scottie 1 and Scottie DX timing.** slowrx has a 428.38 ms Scottie 1
  line and a 1.08053 ms Scottie DX pixel; N7CXI's specification (and
  MMSSTV, and PySSTV) have 428.22 ms and 1.08 ms, which PiRO uses for
  sending and receiving. The Scottie modes also start with an extra 9 ms
  sync pulse after the header (N7CXI); the encoder sends it and the
  receiver skips it, so the live picture lines up.
* **Listening during the FSK ID search.** After a picture slowrx spends up
  to about 2 s looking for an FSK ID and hears nothing else; PiRO also keeps
  listening for the next picture's header meanwhile.
* **A picture can end early.** slowrx always receives a picture's full
  length. PiRO ends it when no sync pulse has been seen for 12 lines (the
  transmission has stopped), when you transmit, or when you press Stop, and
  slant-corrects what arrived.
* **The live picture.** slowrx redraws its window as each line arrives and
  again after correcting; PiRO sends each line to the browser, and the
  corrected picture as a PNG at the end.

## How it is checked

`test/sstv.test.js`:

* **All 25 modes** through PiRO's encoder and the receiver: the VIS header
  is recognised and the first lines decode (mean error under 6 of 255, or
  10 for the Robot colour and PD modes, whose chroma is shared between
  lines).
* **Whole pictures** in Martin 2, Scottie 2, Robot 36, PD 50 and Robot
  8 B/W, fed in uneven chunks: every line arrives live, in order, and the
  final picture matches (mean error 2-6).
* **PySSTV.** `third_party/sstv/make-fixtures.py` makes the start of a
  Robot 36, a Martin M1 and a PD-120 transmission with PySSTV
  (https://github.com/dnet/pySSTV, MIT licence), an encoder written
  independently of slowrx and PiRO; `test/fixtures/sstv-pysstv-*.i16`. All
  three decode to their source picture. While porting, whole PySSTV
  pictures in 13 modes (Martin M1/M2, Scottie S1/S2/DX, Robot 36, PD
  90/120/180, Wraase SC-2 180, Pasokon P3, Robot 8 and 24 B/W) were decoded
  the same way, with mean errors of 1.6 to 7.7.
* **Mistuning** (+110 and -150 Hz) is measured from the header to within
  10 Hz; **clock error** of ±0.25-0.4% (a sender's sound card well off) is
  found and corrected (the error drops from 80-100 to 3-7); a picture at
  about +3 dB S/N is still recognisable, and better with slowrx's adaptive
  window than without; two minutes of noise start no picture; a
  transmission that stops ends the picture early; two pictures in a row are
  both received.

The encoder: for Martin 1, Robot 36 and PD-120, the instantaneous
frequency of its output and of PySSTV's for the same picture agree to a
median of 0.1-1.3 Hz (95% within 4-13 Hz) over the whole transmission, and
the lengths are identical. Scottie 1 has the same length apart from the
starting sync pulse PySSTV leaves out. The FSK ID is read by the receiver
whatever the gap after the picture (and PySSTV's FSK ID reads correctly
too); the CW ID is read by PiRO's CW decoder.

`test/sstv-tx-bridge.test.js` decodes the transmitter's 48 kHz audio back to
the picture and its FSK ID. `test/sstv-decoder-bridge.test.js` runs the real worker through the 48 kHz
audio path and checks the line frames, the PNG (decoded back) and saving.

## Caveats

Not yet tested over the air (receiving or sending). The picture drawn while
it arrives is not yet slant-corrected. Robot 72 follows the published specification rather than
slowrx, and has only been checked against PiRO's own encoder.

## slowrx licence

```
Copyright (c) 2007-2013, Oona Räisänen (OH2EIQ [at] sral.fi)

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
