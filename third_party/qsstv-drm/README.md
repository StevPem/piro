# EasyPal (HamDRM) receiver (from QSSTV)

PiRO's EasyPal receiver is a JavaScript port of the HamDRM receiver in
QSSTV, Johan Maes's (ON4QZ) SSTV program for Linux. QSSTV's receiver in turn
is M. Bos's (PA0MBO) C translation of the "diorama" MATLAB DRM receiver by
Andreas Dittrich and Torsten Schorr (University of Kaiserslautern). No QSSTV
binaries are involved.

| | |
|---|---|
| Upstream | QSSTV, `master` (commit `97156c9`, October 2026), https://github.com/ON4QZ/QSSTV |
| Upstream licence | GPL-2.0-or-later (the drmrx files and `utils/rs.cpp`); QSSTV as a whole GPL-3.0 |
| PiRO licence | AGPL-3.0-only (GPL-3.0 code may be combined with AGPL-3.0 code; the notices are kept below and in each ported file) |
| Copyright | (C) 2009 M. Bos (PA0MBO); (C) 2004 Torsten Schorr; (C) 2000-2019 Johan Maes (ON4QZ); Reed-Solomon (C) 1999 Phil Karn (KA9Q) |

HamDRM is the amateur form of Digital Radio Mondiale (ETSI ES 201 980) that
EasyPal (Erik Sundstrup, VK4AES) made popular for "digital SSTV". QSSTV
sends and receives it compatibly with EasyPal.

## What was ported

| PiRO file | QSSTV source |
|---|---|
| `src/audio/drm/tables.js` | `drmrx/drm.cpp` (mode tables), `drmrx/mkfacmap.cpp`, `drmrx/msd_hard.h`, `drmrx/viterbi_decode.h` |
| `src/audio/drm/dsp.js` | `drmrx/getmode.cpp`, `getofdm.cpp`, `getofdmsync.cpp`, `getfoffsint.cpp`, `getsymbolidx.cpp`, `filter1.cpp`, `filter1c.cpp` |
| `src/audio/drm/demodulator.js` | `drmrx/demodulator.cpp` (time, frequency and frame sync; channel estimation with the 2-D Wiener filter; equalisation; S/N from the FAC) |
| `src/audio/drm/channel-decoder.js` | `drmrx/channeldecode.cpp`, `mkmscmap.cpp`, `deinterleaver.cpp`, `msdhardfac.cpp`, `msdhardmsc.cpp`, `viterbi_decode.cpp`, `crc8_c.cpp` |
| `src/audio/drm/source-decoder.js` | `drmrx/sourcedecoder.cpp`, `crc16_bytewise.cpp`, `bits2bytes.cpp` (packets, MOT header and body, segments) |
| `src/audio/drm/rs.js` | `utils/rs.cpp` (Phil Karn's RS decoder) and `utils/reedsolomoncoder.cpp` (the `.rs1`-`.rs4` file format) |
| `src/audio/drm/receiver.js` | `drmrx/drmrx.cpp` and QSSTV's DRM Hilbert filter (`dsp/filterparam.cpp`): 12 kHz complex input in 1024-sample blocks |
| `src/audio/drm/picture.js`, `src/audio/easypal-decode-worker.js`, `src/server/easypal-decoder-bridge.js` | PiRO's own: JPEG 2000 to PNG (with the `jpeg2000` npm package, Apache-2.0, from PDF.js), the worker thread, the browser events |

Not ported: QSSTV's displays (spectrum, constellation), the hybrid (FTP)
mode, bad segment reports (BSR, which need a transmitter), and the
transmitter itself.

## Differences from QSSTV

* **Double precision.** QSSTV works in `float`; this port in JavaScript's
  doubles. The FFTs are a radix-2 FFT and, for 288 and 160 points, a direct
  DFT (QSSTV uses FFTW).
* **Starting the timing loop.** QSSTV starts its sample-rate tracking at the
  estimate from mode detection. On a noisy signal that estimate can be
  several hundred ppm out, and the receiver then loses the signal before
  the loop unlearns it. PiRO limits the starting value to ±300 ppm (the
  loop still tracks more). Tested: with QSSTV's way the port got 29 of 50
  packets at 10 dB S/N and 10 of 50 with an echo; with the limit, 49 and
  50 (QSSTV itself: 21 and 27). Sound cards up to ±500 ppm still work.
* **Losing the signal.** QSSTV waits 10 bad frames (4 s in mode B) before it
  looks for a signal afresh, which misses the start of a transmission that
  follows another. PiRO waits 3. No difference on the fading tests.
* **The `.rsN` file length.** QSSTV works the decoded file's length out from
  a byte it reads as a signed char, so files often come out with up to a
  block of padding on the end. PiRO works out the exact length.
* **The MOT ContentName.** QSSTV reads the length of a long parameter from
  the wrong byte (which works when the file name is the last parameter);
  PiRO follows the DAB MOT specification.
* **Bugs kept on purpose.** A few odd expressions in QSSTV's tracking loops
  (a `+` that should be a `*` in `getofdm`, an integer division that makes
  a correction zero) are kept, marked "as QSSTV", so the receiver behaves
  like the one EasyPal users already test against.
* **A file received twice** (same transport ID) is not shown again; QSSTV
  says "already received".

## Testing against QSSTV

`harness/` builds QSSTV's own transmitter and receiver as two small
command-line programs (`harness/build.sh`; needs Qt 5 and FFTW). The
transmitter made the test signals in `test/fixtures/easypal-*.ulaw`
(`make-fixtures.js`). The native receiver was used to check the port:

* All 72 combinations of mode (A, B, E), bandwidth (2.3, 2.5 kHz),
  interleave (long, short), QAM (4, 16, 64) and protection (high, normal),
  each with 22 dB S/N, a 25 Hz mistuning and a 20 ppm clock error: PiRO and
  QSSTV both got every file, with the same number of good packets (to
  within one).
* Noise, mistuning (-300 to +400 Hz), clock errors (±150 to ±1000 ppm), an
  echo, fading and deep fades in modes A 64-QAM, B 16-QAM and E 4-QAM: PiRO
  gets as many packets as QSSTV or more in every case.

Not tested yet on an off-air signal, or against EasyPal itself.

## Licence notice (QSSTV drmrx, by M. Bos)

    PA0MBO
    COPYRIGHT (C) 2009 M.Bos
    This file is part of the distribution package RXAMADRM
    This package is free software and you can redistribute is
    and/or modify it under the terms of the GNU General Public License
    More details can be found in the accompanying file COPYING

## Licence notice (msd_hard, viterbi_decode, by Torsten Schorr)

    University of Kaiserslautern, Institute of Communications Engineering
    Copyright (C) 2004 Torsten Schorr
    This program is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 2 of the License, or
    (at your option) any later version.
    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
    GNU General Public License for more details.

## Licence notice (QSSTV, by Johan Maes)

    Copyright (C) 2000-2019 by Johan Maes, on4qz@telenet.be
    This program is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 2 of the License, or
    (at your option) any later version.
    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
    GNU General Public License for more details.

## Licence notice (Reed-Solomon, by Phil Karn)

    Reed-Solomon coding and decoding
    Phil Karn (karn@ka9q.ampr.org) September 1996
    Copyright 1999 Phil Karn, KA9Q
    May be used under the terms of the GNU public license
