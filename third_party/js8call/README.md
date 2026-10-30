# JS8 (from JS8Call-improved)

JS8 is JS8Call's keyboard mode: 8-tone FSK with three 7x7 Costas arrays, a
(174,87) LDPC code and a 12-bit CRC, in UTC slots like FT8. Each frame
carries 12 characters of a 64-character alphabet and 3 bits saying where
it falls in a message. PiRO receives and sends the **Normal** speed (15 s
slots, 6.25 baud, 50 Hz wide) in pure JavaScript, with no JS8Call binaries
involved.

| | |
|---|---|
| Upstream | JS8Call-improved, `master` (commit `0130e04eca17859ccc176c6e7ce0f47dda0d25fb`, JS8Call 3.0.x), https://github.com/JS8Call-improved/JS8Call-improved |
| Upstream licence | GNU GPL version 3 (`LICENSE` in the JS8Call-improved tree) |
| PiRO licence | AGPL-3.0-only (GPL-3.0 section 13 permits combining the two) |
| Copyright | Jordan Sherer (KN4CRD) for JS8Call, its message layer and word list (`Varicode.cpp`, `JSC*.cpp`: "(C) 2018 Jordan Sherer"); Allan Bazinet (W6BAZ) for the C++ decoder (`JS8.cpp`: "(C) 2025 Allan Bazinet"); the JS8Call-improved team; and the WSJT Development Group, whose FT8 (174,87) code and decoder JS8 grew from. The source files say "All Rights Reserved" in their headers; the project is distributed under the GPL, version 3 |

## What was ported

| PiRO file | JS8Call-improved source |
|---|---|
| `src/audio/js8/js8-codec.js` | `JS8_Mode/JS8.cpp`: `encode()` (frame packing, CRC-12, the generator matrix, tone layout), `CRC12()`, `checkCRC12()`, `extractmessage174()`, `bpdecode174()` and its `Mn`/`Nm` tables; `JS8.h` (Costas arrays); `bp_math.h`; `ldpc_feedback.h` (`refineLlrsWithLdpcFeedback()`) |
| `src/audio/js8/js8-decoder.js` | `JS8_Mode/JS8.cpp`, `DecodeMode<ModeA>`: `syncjs8()`, `baselinejs8()`, `computeBasebandFFT()`, `js8_downsample()`, `syncjs8d()`, the core of `js8dec()` (fine time and frequency, symbol spectra, the Costas gate, the four BP passes with feedback, the SNR estimate), `genjs8refsig()`, `subtractjs8()` (the low-pass channel model and its acceptance test), `operator()` (three passes, candidate order); `whitening_processor.h` (the bit likelihoods) |
| `src/audio/js8/js8-modulator.js` | `JS8_Mode/Modulator.cpp` (continuous-phase tones, the fade at the end) |
| `src/audio/js8/js8-varicode.js` | `JS8_Main/Varicode.cpp`: the tables (directed commands, groups, CQ types, Huffman code), callsign, grid and number packing, heartbeat, compound, directed and data frames, checksums, `buildMessageFrames()`; `JS8_Mode/DecodedText.cpp` (how a frame is shown) |
| `src/audio/js8/js8-jsc.js` | `JS8_JSC/JSC.cpp`: `codeword()`, `compress()`, `decompress()`, `lookup()` |
| `src/audio/js8/jsc-words.txt.br` | `JS8_JSC/JSC_map.cpp` (the 262,144 words, by index), made by `make-wordlist.js` here |
| `src/audio/js8/js8-fft.js`, `src/audio/js8-worker.js`, `src/server/js8-bridge.js` | PiRO's own: a mixed-radix FFT (JS8Call uses FFTW), the worker, and the slot timing, transmit queue, PTT, DATA mode and browser side |

Not ported, for a first version:
- the other speeds (Fast, JS8 40, Slow, JS8 60). They differ only in
  their numbers and Costas arrays (`COSTAS_MODIFIED` is already in
  `js8-codec.js`);
- the 3.0 decoder additions: the frequency and timing trackers
  (`FrequencyTracker.cpp`), coherent likelihoods
  (`coherent_likelihood.h`), soft combining across slots
  (`soft_combiner.h`), the deep search for weak sync, the LDPC rescue,
  decoder-aided re-demodulation, and the segmented channel model in
  subtraction (`sic_refinement.h`);
- everything above the frames: automatic replies, heartbeats, relays,
  the inbox and stored messages, APRS, the API. PiRO never transmits
  anything the operator didn't type.

## The word list

`JSC_map.cpp` lists the words by index; `JSC_list.cpp` lists them again in
search order with a prefix table, and JS8Call's compressor takes the first
listed word the text starts with. `make-wordlist.js` checks that this is
always the longest such word in the word's group, and that only `@ALLCALL`
(index 81) can't be reached, so `js8-jsc.js` needs only the words by index.
It keeps two quirks so PiRO sends what JS8Call sends: `@ALLCALL` is never
used as a word, and "ROSIDS" (index 262143, listed with size 1) steps over
one character. Two words are not printable (69 is a newline, 72 is 0x1A);
their lines are left empty in the file and filled in when it is read.

To make it again from a JS8Call-improved tree:

    node third_party/js8call/make-wordlist.js JS8CALL_SOURCE_DIR

The output is the same file byte for byte.

## How the port is checked

`test/js8.test.js`:
- the FFT against a direct DFT;
- the generator against the parity checks (every codeword passes all 87),
  the check lists against JS8Call's `Nm` table, BP on clean and noisy
  codewords, the CRC;
- callsign, grid and compound-callsign packing round trips; messages built
  and shown exactly as JS8Call shows them (CQ, heartbeat, directed
  commands with numbers, /P, free text to a station, "MYCALL: text", a MSG
  with its checksum, the first/last flags);
- the receiver on simulated slots: four signals at once (one overlapping
  another 20 Hz away, one at −16 dB), timing errors of ±0.3 s, noise only;
  and a whole message sent over several slots read back;
- the bridge with its worker: a slot of 48 kHz audio decoded and spotted,
  a message sent a frame a slot (the audio played is decoded again: right
  frame, offset and timing), Stop, the limits.

What isn't checked yet: interworking with JS8Call itself. JS8Call-improved
has no test vectors, and building it needs Qt 6.12, Boost, FFTW and
Hamlib. The tables were taken from its source by script, not by hand, but
a recording of real JS8 signals (and a QSO on air) is still needed.
