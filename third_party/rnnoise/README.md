# Patched `rnnoise_demo`

`rnnoise_demo.c` here is [xiph/rnnoise](https://github.com/xiph/rnnoise)'s
`examples/rnnoise_demo.c` with one change: an optional third argument,
`wet`, that blends the denoised and original audio.

```
rnnoise_demo <input> <output> [wet 0.0-1.0]
out = wet * denoised + (1 - wet) * original
```

- Omit `wet` (or pass `1.0`) and the output is identical to stock RNNoise,
  so the patched binary is a drop-in replacement.
- `0.0` passes the audio through untouched.

PiRO uses this for the multi-level "RNN" button: stock RNNoise tends to mute
weak but real signals along with the noise, and a partial blend keeps them
audible. The levels come from the `RNNOISE_WET` setting (default
`0.25,0.5,0.75,1.0`).

PiRO needs this patched build. It always passes the `wet` argument (even at
`1.0`), and stock `rnnoise_demo` rejects a third argument with a usage error.

The file keeps RNNoise's original BSD-3-Clause copyright and licence header
(Copyright (c) 2018 Gregor Richards, (c) 2017 Mozilla). RNNoise itself is not
included in this repository. See the top-level `README.md` for build steps.
