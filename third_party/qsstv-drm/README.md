# EasyPal (HamDRM) receiver and transmitter (from QSSTV)

PiRO's EasyPal receiver is a JavaScript port of the HamDRM receiver in
QSSTV, Johan Maes's (ON4QZ) SSTV program for Linux. QSSTV's receiver in turn
is M. Bos's (PA0MBO) C translation of the "diorama" MATLAB DRM receiver by
Andreas Dittrich and Torsten Schorr (University of Kaiserslautern). The
transmitter is a port of QSSTV's `drmtx`, which M. Bos adapted for ham SSTV
from Dream, the DRM software of Volker Fischer at Technische Universitaet
Darmstadt. No QSSTV binaries are involved.

| | |
|---|---|
| Upstream | QSSTV, `master` (commit `97156c9`, October 2026), https://github.com/ON4QZ/QSSTV |
| Upstream licence | GPL-2.0-or-later (the drmrx and drmtx files and `utils/rs.cpp`); QSSTV as a whole GPL-3.0 |
| PiRO licence | AGPL-3.0-only (GPL-3.0 code may be combined with AGPL-3.0 code; the notices are kept below and in each ported file) |
| Copyright | (C) 2009 M. Bos (PA0MBO); (C) 2004 Torsten Schorr; (C) 2001-2007 Technische Universitaet Darmstadt, Institut fuer Nachrichtentechnik (Volker Fischer, Andrew Murphy; Dream); (C) 2000-2019 Johan Maes (ON4QZ); Reed-Solomon (C) 1999 Phil Karn (KA9Q) |

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
| `src/audio/drm/transmitter.js` | `drmtx/` (Dream as adapted by PA0MBO): `common/datadecoding/DABMOT.cpp`, `MOTSlideShow.cpp`, `DataDecoder.cpp` (MOT objects, segments, data groups, packets), `common/FAC/FAC.cpp`, `common/mlc/` (`MLC.cpp`, `ConvEncoder.cpp`, `ChannelCode.cpp`, `EnergyDispersal.cpp`, `BitInterleaver.cpp`, `QAMMapping.cpp`), `common/interleaver/SymbolInterleaver.cpp`, `BlockInterleaver.cpp`, `common/ofdmcellmapping/` (`CellMappingTable.cpp`, `OFDMCellMapping.cpp`), `common/OFDM.cpp`, `common/util/CRC.cpp`, and `drmtransmitter.cpp` (the settings) |
| `src/audio/drm/tx-picture.js`, `src/audio/easypal-encode-worker.js`, `src/server/easypal-tx-bridge.js` | PiRO's own: the picture fitted to the time (`jpeg-js`), the worker thread, the radio (DATA mode, power, PTT) |
| `src/audio/drm/picture.js`, `src/audio/easypal-decode-worker.js`, `src/server/easypal-decoder-bridge.js` | PiRO's own: JPEG 2000 decoded (the `jpeg2000` npm package, Apache-2.0, from PDF.js), shrunk to at most 1600 pixels and sent as JPEG (`jpeg-js`, BSD-3-Clause), the worker thread, the browser events |

Not ported: QSSTV's displays (spectrum, constellation), the hybrid (FTP)
mode, bad segment reports (BSR: neither answering them nor asking for
them yet), and sending more than one file or text.

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

## The transmitter

The port follows QSSTV's `drmtx` step for step. It was checked with the
harness's `tx_main.cpp` (QSSTV's own transmitter): the same file, file name
and callsign gave the same number of frames and the same audio, frame by
frame (correlation 1.00000; at most 2 parts in 32768 apart, about
-83 dB), in modes A, B and E, long and short interleave, and 4-, 16- and
64-QAM. QSSTV's receiver and PiRO's both decode it exactly. Details kept
from QSSTV:

* The FAC: in odd frames QSSTV leaves bits 31 to 39 of its buffer as the
  energy-dispersal sequence left them (it scrambles that buffer in place).
  PiRO sends the same bits, marked "as QSSTV".
* The frame count: QSSTV sends one frame fewer than it has packets (the
  last packet is never sent). PiRO does the same, so transmissions are the
  same length.
* The OFDM modulator: a sum over the carriers in use (at most 207) rather
  than an FFT, which is as exact and faster in JavaScript. The signal is
  centred as QSSTV centres it (DC at 350 Hz; the carriers from about 400
  to 2750 Hz).

PiRO adds the rest of a transmission: the picture is fitted to a time
(`EASYPAL_TX_SECONDS`), protected with Reed-Solomon (`.rs1`-`.rs4`, as
EasyPal and QSSTV write it), and named `CALL-YYYYMMDD-HHMMSS`.

Tested on air on 25 October 2026: PiRO (build v102, mode B, 16-QAM, high
protection, short interleave, RS2, 90 s) on VK3TR's IC-7300, 28.690 MHz
USB, recorded on the KiwiSDR at vk3jst.ddns.net. The receiver decoded the
15 kB JPEG at about 9 dB S/N, with 42 of 176 segments put back by
Reed-Solomon. The first 22 s of the recording is
`test/fixtures/easypal-onair.ulaw`. Not yet tried with EasyPal itself.

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

A recording of a real EasyPal transmission found online (4 minutes, mode
A, 64-QAM, long interleave, a 3648 x 2736 JPEG 2000 photo sent as `.rs2`,
callsign N0CALL; the audio had been through YouTube's AAC) decoded: 588 of
595 frames good, the picture complete after 431 of its 570 segments, the
other 139 put back by Reed-Solomon. QSSTV's receiver got 565 good packets from the
same recording. Not tested yet on a signal received off air by PiRO.

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

## Licence notice (Dream, in QSSTV drmtx)

    Technische Universitaet Darmstadt, Institut fuer Nachrichtentechnik
    Copyright (c) 2001-2007
    Author(s): Volker Fischer, Andrew Murphy
    Adapted for ham sstv use Ties Bos - PA0MBO

    This program is free software; you can redistribute it and/or modify it under
    the terms of the GNU General Public License as published by the Free Software
    Foundation; either version 2 of the License, or (at your option) any later
    version.

    This program is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
    FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
    details.

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
