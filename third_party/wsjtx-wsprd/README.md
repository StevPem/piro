# WSPR (wsprd and wsprsim from WSJT-X)

WSPR ("Weak Signal Propagation Reporter") is K1JT's beacon mode: 2-minute
slots on even UTC minutes, 162 symbols of 4-FSK at 1.46 baud, 6 Hz wide,
carrying a callsign, a grid and a power in 50 bits under a K=32 rate-1/2
convolutional code. PiRO sends and receives it in pure JavaScript, with no
WSJT-X binaries involved.

| | |
|---|---|
| Upstream | WSJT-X, `lib/wsprd/` and `Network/wsprnet.cpp`, https://sourceforge.net/projects/wsjt/ (mirror: https://github.com/WSJTX/wsjtx) |
| Upstream licence | GNU GPL version 3 (`COPYING` in the WSJT-X tree) |
| PiRO licence | AGPL-3.0-only (GPL-3.0 section 13 permits combining the two) |
| Copyright | wsprd: 2001-2018 Joe Taylor K1JT; 2014-2018 Steven Franke K9AN. Fano decoder: 1994 Phil Karn KA9Q. Hash: 2006 Bob Jenkins (public domain) |

## What was ported

| PiRO file | WSJT-X source |
|---|---|
| `src/audio/wspr-codec.js` | `wsprsim_utils.c` (message packing, interleaver, sync vector, channel symbols), `fano.c` (convolutional encoder and Fano sequential decoder), `tab.c` (parity), `nhash.c` (callsign hash), `wsprd_utils.c` (unpacking type 1, 2 and 3 messages, deinterleaver), `metric_tables.c` (the Fano metric table, as wsprd builds it with bias 0.45) |
| `src/audio/wspr-rx.js` | `wsprd.c`: baseband conversion (`readwavfile`), the spectrum and candidate search, coarse time/frequency/drift search, `sync_and_demodulate`, `noncoherent_sequence_detection`, `subtract_signal2`, and the three-pass main loop with its thresholds and de-duplication |
| `src/server/wsprnet.js` | the spot and "wsprstat" form fields of `Network/wsprnet.cpp` |
| `src/audio/wspr-decode-worker.js`, `src/server/wspr-bridge.js` | PiRO's own glue: worker thread, slot timing, transmit scheduling, power limit, unattended receive |

## Differences from wsprd

- The baseband conversion uses a 2^21-point FFT instead of 1474560 points.
  The output rate (375 Hz) and scale are the same.
- wsprd's optional OSD decoder (`-o`) and stack decoder (`-J`) are not
  ported; wsprd runs neither by default.
- A decode deadline (PiRO's own): after it, the Fano limit drops from 10000
  to 200 cycles per bit, so a slot full of noise candidates still finishes
  on a Pi.
- A decoded callsign with a space in the middle is dropped as a false
  decode (wsprd prints it cut at the space).

## Checks

The encoder matches `wsprsim -c` symbol for symbol (types 1, 2 and 3;
`test/wspr.test.js` keeps the reference symbols). On the same signals
(`wsprsim` .c2 files, and 12 kHz WAV files at -28 to -33 dB), the port
decoded the same messages as a `wsprd` built from these sources, at the same
rate near the threshold (about -31 dB in 2500 Hz).
