# JTTY test fixtures

Generated with WSJT-X's own reference encoder, `sjtty` (WSJT-X `release/3.3`,
commit `57ba933`, built from `lib/jtty` with gfortran), so the JavaScript port
is checked against the real implementation, not against itself.

* `jtty-vectors.json` — rows of `[text, exchangeProfile, frames, canonicalText,
  tones]`. `frames` is the frame count `sjtty` reports, `canonicalText` is the
  text after `sjtty`'s pack/unpack round trip (what the receiver would show),
  and `tones` is the full channel-symbol sequence (digits 0-3, 59 per frame)
  from `sjtty "<text>" 1500 0.0 AW 1 384 1 99`. Made with
  `sjtty --exchange-profile=<profile> "<text>"` for each row.
* `jtty-cq-k1abc-cq-1500hz.i16` — raw little-endian signed 16-bit samples, 12 kHz
  mono: the first frame (22 656 samples) of the WAV `sjtty "CQ K1ABC CQ" 1500
  0.0 AW 1 384 1 99` writes. With SNR set above 90 dB `sjtty` writes the clean
  signal scaled so its peak is 32766.9.

* `jtty-wsjtx-sample-260807_134110.wav` — the JTTY sample recording shipped
  with WSJT-X (`samples/JTTY/260807_134110.wav`, `release/3.3`): ten frames of
  "RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!" near 1507 Hz. Used by
  `test/jtty-rx.test.js`; the same file is decoded by WSJT-X's `rjtty`.

To regenerate, build `sjtty` from the WSJT-X sources and rerun it over the
message list in `jtty-vectors.json`. The messages mix every atom type the
grammar defines, spec examples under each exchange profile, lowercase and
unsupported-character input, and over-long text.
