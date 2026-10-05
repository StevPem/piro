/* Copyright (c) 2018 Gregor Richards
 * Copyright (c) 2017 Mozilla */
/*
   Redistribution and use in source and binary forms, with or without
   modification, are permitted provided that the following conditions
   are met:

   - Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

   - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
   ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
   LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
   A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION OR
   CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
   EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
   PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
   PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
   LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
   NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
   SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*
 * Patched 2026-09-30 (VK3TR / PiRO project) to add wet/dry blending,
 * driven by the PiRO app's 5-state "RNN" button.
 *
 * Stock rnnoise_demo always writes the fully-denoised frame. On
 * weak/borderline HF signals, the network's gain estimate can be
 * aggressive enough to crush genuinely weak-but-present signal along
 * with the noise, so this patch lets the operator dial back how much of
 * the denoised signal is used, per-frame:
 *
 *   out = wet * denoised + (1 - wet) * original
 *
 * `wet` is a single fixed ratio for the whole run, taken from an
 * optional 3rd argv (0.0-1.0) and left at 1.0 (fully denoised, i.e.
 * byte-for-byte identical to stock unpatched behavior) if that argv is
 * omitted — so a plain two-argument invocation
 * (`rnnoise_demo <in> <out>`) is unchanged.
 *
 * This is a flat ratio, NOT modulated per-frame by RNNoise's own VAD
 * (speech-confidence) output — an earlier revision of this patch did
 * that (ratio floor rising toward 1.0 as VAD confidence rose), but the
 * PiRO app's "RNN" button now exposes 4 fixed levels instead (25/50/75/
 * 100% denoised), so this version keeps `wet` constant for simplicity
 * and predictability: what the button says is exactly what you get,
 * frame to frame. rnnoise_process_frame()'s VAD return value is still
 * computed as a side effect of denoising `x` but is otherwise unused.
 *
 * The PiRO app's server side (src/server/audio-bridge.js,
 * RNNOISE_LEVEL_WET) invokes this binary with wet = 0.25/0.5/0.75/1.0
 * for the "RNN 1".."RNN 4" button states; "RNN Off" doesn't spawn this
 * binary at all. Invoking by hand, try 0.5-0.7 as a starting point for
 * weak-signal SSB work: 0.0 passes the original signal through
 * completely unfiltered (no noise reduction at all); 1.0 is stock
 * behavior (fully denoised, no blending).
 */

#include <stdio.h>
#include <stdlib.h>
#include "rnnoise.h"

#define FRAME_SIZE 480

int main(int argc, char **argv) {
  int i;
  int first = 1;
  float x[FRAME_SIZE];
  short orig[FRAME_SIZE];
  FILE *f1, *fout;
  DenoiseState *st;
  float wet = 1.0f; /* see file header -- 1.0 = stock behavior, no blending */
#ifdef USE_WEIGHTS_FILE
  RNNModel *model = rnnoise_model_from_filename("weights_blob.bin");
  st = rnnoise_create(model);
#else
  st = rnnoise_create(NULL);
#endif

  if (argc!=3 && argc!=4) {
    fprintf(stderr, "usage: %s <noisy speech> <output denoised> [wet 0.0-1.0]\n", argv[0]);
    return 1;
  }
  if (argc==4) {
    wet = (float) atof(argv[3]);
    if (wet < 0.0f) wet = 0.0f;
    if (wet > 1.0f) wet = 1.0f;
  }
  f1 = fopen(argv[1], "rb");
  fout = fopen(argv[2], "wb");
  while (1) {
    short tmp[FRAME_SIZE];
    fread(tmp, sizeof(short), FRAME_SIZE, f1);
    if (feof(f1)) break;
    for (i=0;i<FRAME_SIZE;i++) { orig[i] = tmp[i]; x[i] = tmp[i]; }
    /* Return value (VAD confidence) is intentionally unused -- see file
       header for why this patch no longer modulates `wet` with it. */
    (void) rnnoise_process_frame(st, x, x);
    for (i=0;i<FRAME_SIZE;i++) {
      float blended = wet * x[i] + (1.0f - wet) * (float) orig[i];
      if (blended > 32767.0f) blended = 32767.0f;
      if (blended < -32768.0f) blended = -32768.0f;
      tmp[i] = (short) blended;
    }
    if (!first) fwrite(tmp, sizeof(short), FRAME_SIZE, fout);
    first = 0;
  }
  rnnoise_destroy(st);
  fclose(f1);
  fclose(fout);
#ifdef USE_WEIGHTS_FILE
  rnnoise_model_free(model);
#endif
  return 0;
}
