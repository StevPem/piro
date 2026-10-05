# Bundled models: HamNoise

`denoise-cw.wasm` and `denoise-voice.wasm` in this directory are copied,
unmodified, from:

https://github.com/e04/HamNoise

(`web/public/denoise-cw.wasm` and `web/public/denoise-voice.wasm` at commit
`1af3a77b2ff18dada2149f36686430cdae7cf13c`, 2026-07-05) — the exact prebuilt
binaries that project's own live web demo (https://e04.github.io/HamNoise/)
ships and runs, not a rebuild from source. `src/audio/hamnoise-filter.js`
loads them directly and calls their exported `denoise_web_*` functions
(documented in that project's `web/wasm/denoise_web.c`); none of the actual
denoising DSP/model math is reimplemented here.

Copyright (C) the HamNoise project authors. Licensed under the GNU Affero
General Public License, version 3 (AGPL-3.0) — see `LICENSE` in this
directory for the full text, or
https://github.com/e04/HamNoise/blob/main/LICENSE for the canonical copy.
Same license family as the `models/deepcw/` bundle (see that directory's own
`NOTICE.md`), so this doesn't change PiRO's own licensing conclusion —
PiRO was already AGPL-3.0-only because of that bundle.

## What each binary is

Two separately-compiled WASM modules, not one model with a mode switch —
`denoise-cw.wasm` only understands HamNoise's CW-targeted model, and
`denoise-voice.wasm` only understands its voice/SSB-targeted model (each
binary's `denoise_web_set_model()` only accepts the model IDs actually
compiled into it — see `denoise_web.c`'s `denoise_web_model_supported()`).
Both run their model at a fixed internal sample rate of 9600Hz, regardless
of the audio pipeline's actual capture rate; `hamnoise-filter.js` resamples
to and from that rate itself (see that file's own doc comment), unlike
RNNoise's integration (`rnnoise-filter.js`), which requires the capture rate
to already match RNNoise's own expectation.

Both binaries use HamNoise's newer "v2" (band-split RNN) architecture —
confirmed from `web/src/hooks/useDenoise.ts`'s own `effectiveModelId` logic,
which defaults to the v2 model unless the operator opts into that project's
"legacy" (plain GRU) models — so this bundle does the same rather than
preferring an older generation HamNoise's own UI treats as a fallback.

## A known, disclosed upstream caveat

As of the commit this was vendored from, HamNoise's own repository has an
open issue (https://github.com/e04/HamNoise/issues/1) reporting that its
"v2 parity test" — a correctness check comparing this exact WASM engine's
output against reference data — fails for both the CW and voice v2 models.
The issue's own analysis leaves open whether that's a bug in the engine or
simply stale reference data. Either way, this bundle uses the *exact same*
prebuilt binary the project's own public web demo runs in production, so
whatever behavior that issue describes is already what every user of
HamNoise's own site experiences today — bundling it here introduces no
additional risk beyond what upstream already ships, but it's worth knowing
about if HamNoise's denoised RX audio (CW-mode or voice-mode) ever sounds
suspect. Note this is unrelated to PiRO's own "CW3" (DeepCW) decoder — see
`hamnoise-filter.js`'s doc comment for why HamNoise is wired into the RX
audio path, not the decoder path.
