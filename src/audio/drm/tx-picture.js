'use strict';

/**
 * Fits a picture to an EasyPal transmission time: at most MAX_WIDTH x
 * MAX_HEIGHT (keeping its shape), then the best JPEG quality (30-90) whose
 * file, with its Reed-Solomon protection, goes out in the time allowed. If
 * even quality 30 is too big, the picture is made smaller (by about as
 * much as the file must shrink) down to 160 pixels on its short side, and
 * only then the quality lowered.
 *
 * Guide: mode B 16-QAM with RS2 sends a JPEG of about 15 kB in 90 s, 22 kB
 * in 120 s and 34 kB in 180 s. A photo at 800 x 600 needs about 30-40 kB at
 * quality 40-50, so 90 s gives about 430-550 pixels across.
 */

const jpeg = require('jpeg-js');
const rs = require('./rs');

const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;
const MIN_QUALITY = 30; // below this a smaller picture looks better than a blockier one
const LAST_QUALITY = 10; // ...unless it is as small as it goes
const MAX_QUALITY = 90;
const MIN_SIDE = 160;

/** Resamples RGBA to w x h (area average when shrinking). */
function resize(src, sw, sh, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const fx = sw / w;
  const fy = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** What will be sent for this JPEG: the file itself or its .rsN form. */
function payload(jpg, rsType) {
  if (!rsType) return { data: jpg, ext: 'jpg' };
  return { data: rs.encodeFile(jpg, 'jpg', rsType), ext: rsType };
}

/**
 * @param {Buffer} input a JPEG (or anything jpeg-js reads)
 * @param {object} opts
 * @param {import('./transmitter').HamDrmTransmitter} opts.tx
 * @param {number} opts.seconds the longest the transmission may take
 * @param {string|null} opts.rsType 'rs1'..'rs4', or null for none
 * @param {string} opts.name the file name, without extension
 * @returns {{jpeg: Buffer, data: Buffer, ext: string, width: number, height: number, quality: number, seconds: number}}
 */
function fitPicture(input, { tx, seconds, rsType, name }) {
  const img = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  let scale = Math.min(1, MAX_WIDTH / img.width, MAX_HEIGHT / img.height);
  for (;;) {
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const rgba = scale === 1 ? Buffer.from(img.data) : resize(img.data, img.width, img.height, w, h);
    const tryQ = (q) => {
      const jpg = jpeg.encode({ data: rgba, width: w, height: h }, q).data;
      const p = payload(jpg, rsType);
      return { jpeg: jpg, ...p, width: w, height: h, quality: q, seconds: tx.secondsFor(p.data.length, name, p.ext) };
    };
    const search = (lo, hi) => {
      let best = null;
      while (lo <= hi) {
        const q = (lo + hi) >> 1;
        const r = tryQ(q);
        if (r.seconds <= seconds) {
          best = r;
          lo = q + 1;
        } else hi = q - 1;
      }
      return best;
    };
    // quality 30 first: if even that is too big, make the picture smaller
    // (the file size goes about with the area) without searching here
    const low = tryQ(MIN_QUALITY);
    if (low.seconds <= seconds) return search(MIN_QUALITY + 1, MAX_QUALITY) ?? low;
    if (Math.min(w, h) <= MIN_SIDE) return search(LAST_QUALITY, MIN_QUALITY - 1) ?? tryQ(LAST_QUALITY); // the caller checks the time
    const overhead = tx.secondsFor(1, name, low.ext);
    const ratio = Math.max(0, seconds - overhead) / Math.max(1e-6, low.seconds - overhead);
    const step = Math.min(0.9, Math.max(0.4, Math.sqrt(ratio) * 0.97));
    scale = Math.max(scale * step, Math.min(scale * 0.9, MIN_SIDE / Math.min(img.width, img.height)));
  }
}

module.exports = { fitPicture, resize, MAX_WIDTH, MAX_HEIGHT };
