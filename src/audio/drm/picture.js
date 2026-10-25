'use strict';

/**
 * Turns a file received over HamDRM into something a browser can show.
 * EasyPal and QSSTV send JPEG or JPEG 2000 pictures (and sometimes other
 * files). Browsers show JPEG, PNG, GIF, WebP and BMP themselves; JPEG 2000
 * is decoded here (jpeg2000, after PDF.js; Apache-2.0), shrunk to at most
 * 1600 pixels across, and sent as a JPEG (jpeg-js; BSD-3-Clause): a PNG of
 * a photo is several times bigger.
 */


// EasyPal pictures can be camera-sized (a 10-megapixel JPEG 2000 file of
// 100 kB is normal). What is shown in the browser is cut down to this.
const MAX_SHOWN = 1600;
const JPEG_QUALITY = 85;

/** Shrinks RGB to fit MAX_SHOWN, averaging each block of pixels. */
function shrink(rgb, width, height) {
  const f = Math.ceil(Math.max(width, height) / MAX_SHOWN);
  if (f <= 1) return { rgb, width, height };
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const out = new Uint8Array(w * h * 3);
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let s = ((y * f + dy) * width + x * f) * 3;
        for (let dx = 0; dx < f; dx++, s += 3) {
          r += rgb[s];
          g += rgb[s + 1];
          b += rgb[s + 2];
        }
      }
      const d = (y * w + x) * 3;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
    }
  }
  return { rgb: out, width: w, height: h };
}

const TYPES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' },
  { mime: 'image/gif', test: (b) => b.toString('latin1', 0, 4) === 'GIF8' },
  { mime: 'image/webp', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { mime: 'image/bmp', test: (b) => b.toString('latin1', 0, 2) === 'BM' },
  { mime: 'image/jp2', test: (b) => b.readUInt32BE(0) === 12 && b.toString('latin1', 4, 8) === 'jP  ' },
  { mime: 'image/j2k', test: (b) => b[0] === 0xff && b[1] === 0x4f && b[2] === 0xff && b[3] === 0x51 },
];

/** The file's type from its first bytes (null if not a known picture). */
function sniff(data) {
  if (!data || data.length < 12) return null;
  const t = TYPES.find((x) => x.test(data));
  return t ? t.mime : null;
}

/** Width and height of a JPEG, from its SOF segment (null if not found). */
function jpegSize(b) {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      p += 2;
      continue;
    }
    const len = b.readUInt16BE(p + 2);
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5) };
    }
    p += 2 + len;
  }
  return null;
}

/** Decodes JPEG 2000 (a .jp2 file or a bare code stream) to RGB. */
function decodeJpeg2000(data) {
  const { JpxImage } = require('jpeg2000');
  const jpx = new JpxImage();
  jpx.parse(data);
  const { width, height, componentsCount: nc } = jpx;
  const rgb = new Uint8Array(width * height * 3);
  for (const t of jpx.tiles) {
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        const s = (y * t.width + x) * nc;
        const d = ((t.top + y) * width + t.left + x) * 3;
        if (nc >= 3) {
          rgb[d] = t.items[s];
          rgb[d + 1] = t.items[s + 1];
          rgb[d + 2] = t.items[s + 2];
        } else rgb[d] = rgb[d + 1] = rgb[d + 2] = t.items[s];
      }
    }
  }
  return { width, height, rgb };
}

/**
 * @param {Buffer} data the received file
 * @param {string} fileName
 * @returns {{mime:string, data:Buffer, width?:number, height?:number}|{text:string}|null} what to show, or null
 */
function toDisplay(data, fileName = '') {
  const mime = sniff(data);
  if (mime === 'image/jp2' || mime === 'image/j2k') {
    const full = decodeJpeg2000(data);
    const { width, height, rgb } = shrink(full.rgb, full.width, full.height);
    const rgba = Buffer.alloc(width * height * 4, 255);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgba[j] = rgb[i];
      rgba[j + 1] = rgb[i + 1];
      rgba[j + 2] = rgb[i + 2];
    }
    const jpeg = require('jpeg-js').encode({ data: rgba, width, height }, JPEG_QUALITY).data;
    return { mime: 'image/jpeg', data: jpeg, width, height, from: mime, fullWidth: full.width, fullHeight: full.height };
  }
  if (mime) {
    const size = mime === 'image/jpeg' ? jpegSize(data) : null;
    return { mime, data, ...(size || {}) };
  }
  if (/\.(txt|chat)$/i.test(fileName)) return { text: data.toString('utf8').slice(0, 4000) };
  return null;
}

module.exports = { toDisplay, sniff, jpegSize, decodeJpeg2000, shrink, MAX_SHOWN };
