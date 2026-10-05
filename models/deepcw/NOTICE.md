# Bundled model: DeepCW

`model.onnx` and `model.onnx.json` in this directory are copied, unmodified,
from:

https://github.com/e04/deepcw-engine

Copyright (C) the deepcw-engine project authors. Licensed under the
GNU Affero General Public License, version 3 only (AGPL-3.0-only) — see
`LICENSE` in this directory for the full text, or
https://github.com/e04/deepcw-engine/blob/main/LICENSE for the canonical
copy.

## Why this changes PiRO's own licence

PiRO was previously GPL-3.0-or-later. GPLv3 §13 and AGPLv3 §13 contain a
reciprocal permission specifically for combining a GPLv3 work with an
AGPLv3 work into one combined work; the combination as a whole is then
governed by AGPLv3 (including its §13 network-interaction clause: anyone
interacting with a running instance over a network is entitled to the
corresponding source). Because this model is now bundled into and run by
PiRO, the whole project is licensed AGPL-3.0-only from this point on —
see the top-level `LICENSE` file and `README.md`'s "Licence" section.

## Decoder implementation

The actual preprocessing (spectrogram generation) and CTC decode in
`src/audio/deepcw-decoder.js` follow the same approach as
deepcw-engine's own `examples/nodejs/decode_morse.mjs` (same repo, same
licence), adapted to run continuously against PiRO's live RX audio
stream instead of a single pre-recorded WAV file — see that file's own
doc comment for the details of that adaptation (windowing, resampling,
silence-skipping).
