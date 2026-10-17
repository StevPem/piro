# Feld-Hell (from fldigi)

Feld-Hell is Rudolf Hell's 1929 Hellschreiber: text is sent as a picture,
each character drawn column by column from a raster font by keying a single
tone on and off, and the receiver paints what it hears. PiRO sends and
receives it in pure JavaScript, compatible with fldigi, with no fldigi
binaries involved.

| | |
|---|---|
| Upstream | fldigi, `master` (version 4.1.23, commit `61b97f4`), https://github.com/w1hkj/fldigi |
| Upstream licence | GNU GPL version 3 (`COPYING` in the fldigi tree) |
| PiRO licence | AGPL-3.0-only (GPL-3.0 section 13 permits combining the two) |
| Copyright | David Freese W1HKJ and the fldigi contributors (the Feld-Hell modem and fonts) |

## What was ported

| PiRO file | fldigi source |
|---|---|
| `src/audio/hell-font.js` | `src/feld/FeldHell-12.cxx`, fldigi's default font ("hell 12"), converted by `make-font.js` |
| `src/audio/hell-tx.js` | the transmit side of `src/feld/feld.cxx`: `get_font_data()`, `nco()`, `send_symbol()`, `send_null_column()`, `tx_char()`, the preamble and postamble in `tx_process()`, and `initKeyWaveform()` |
| `src/audio/hell-rx.js` | the receive side of `src/feld/feld.cxx` (`rx()`, `rx_process()`): mix down, low-pass, peak per pixel, the decaying peak hold that scales the picture |
| `src/server/hell-decoder-bridge.js`, the picture in `src/client/scope.js` | PiRO's own glue: 48 kHz to 8 kHz decimation, column frames to the browser, and fldigi's two-column receive display (`col_data` in `rx()`) drawn on the scope canvas |

Settings are fldigi's defaults for Feld-Hell: 8 kHz, 17.5 columns a second,
14 half-pixels a column (245 a second, 122.5 baud), the 2 ms raised-cosine
key shape (`HellPulseFast` 1), each column sent once (`HellXmtWidth` 1), the
"..." preamble and postamble, 20 receive pixels per column. The other Hell
modes fldigi offers (Slow Hell, Hell x5/x9, FSK Hell, Hell 80) are not
ported.

## Differences from fldigi

* **Receive filter.** fldigi takes the Hilbert transform of the 8 kHz input,
  mixes it down and filters it with an FFT filter, all at 8 kHz. PiRO mixes
  the real input down and low-passes it with a 161-tap Blackman-windowed FIR
  (150 Hz cutoff), computing only every fourth output (2 kHz), which is far
  cheaper on a Raspberry Pi. The real-input mixer's image at twice the tone
  frequency is far outside the filter, so the picture is the same.
* **Display.** fldigi's receive window is its own widget; PiRO draws the
  columns into the scope's waterfall canvas, each one stacked over the
  previous one exactly as fldigi's window does (it always hands its display
  the previous and current column together), so a whole line of text is
  always visible however it has drifted up or down. There is no slant
  correction control yet (`HellReceiver`'s `columnRate` option allows one).
* **Characters outside the font.** fldigi sends each byte of a UTF-8
  character as a blank gap; PiRO sends one gap per character and reports
  which characters those were.

## How the port is checked

`third_party/feldhell/feld_ref.cpp` is fldigi's own transmit code, copied
with the GUI and sound-card plumbing removed and fldigi's defaults fixed.
Build it against fldigi's font file:

```bash
git clone --depth 1 https://github.com/w1hkj/fldigi
g++ -O2 -std=c++14 -w -I fldigi/src/feld -o feld_ref third_party/feldhell/feld_ref.cpp
node third_party/feldhell/make-fixtures.js ./feld_ref
node third_party/feldhell/make-font.js fldigi/src/feld/FeldHell-12.cxx   # regenerates src/audio/hell-font.js
```

That regenerates `test/fixtures/hell-vectors.json` and
`test/fixtures/hell-cq-1000hz.i16`, which `test/hell.test.js` checks:

* **40 messages** (empty, one character, a CQ, the whole font, line breaks,
  characters outside the font, and random QSO text at random tones from 300
  to 2700 Hz): the complete half-pixel sequence must match the reference
  exactly, and `hellDurationSec()` must predict its length.
* **One reference waveform** ("CQ DE VK3TR" at 1000 Hz): matches to 1 LSB.
  In practice the JS output was identical to the reference's float32 output
  for every message tried.

fldigi's receiver is not wrapped in a reference program (it is bound up
with its display), so the receiver is checked against what was sent: the
received picture must correlate with the transmitted half-pixels (r > 0.9
clean, > 0.7 at about 0 dB S/N in 3 kHz, > 0.8 40 Hz off tune), a signal
800 Hz away must not be painted, the output must not depend on the chunk
size, and the 48 kHz audio path must give the same picture.
`test/hell-decoder-bridge.test.js` covers the server bridge and
`test/manual-tty-ui.js` the scrolling picture in a browser.

## Caveats

Not yet tested over the air. Like fldigi, the receiver listens at one tone;
a signal more than about 150 Hz away is not painted, so click the spectrum on
it first.
