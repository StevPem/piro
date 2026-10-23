'use strict';

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * A minimal PNG encoder (8-bit RGB, no interlace, each row filtered with
 * "Sub"), for the received SSTV pictures; uses only Node's zlib.
 * @param {Uint8Array} rgb - width * height * 3 bytes, row by row
 * @returns {Buffer}
 */
function encodePng(rgb, width, height) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1; // Sub
    for (let i = 0; i < stride; i++) {
      const v = rgb[y * stride + i];
      raw[o + 1 + i] = (v - (i >= 3 ? rgb[y * stride + i - 3] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The same for an 8-bit greyscale picture (radiofax charts), compressed
 * without blocking: a 25-minute chart is several megabytes of pixels.
 * @param {Uint8Array} grey - width * height bytes
 * @returns {Promise<Buffer>}
 */
function encodePngGrey(grey, width, height) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width + 1);
    raw[o] = 1; // Sub
    for (let i = 0; i < width; i++) raw[o + 1 + i] = (grey[y * width + i] - (i ? grey[y * width + i - 1] : 0)) & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return new Promise((resolve, reject) =>
    zlib.deflate(raw, { level: 6 }, (err, data) =>
      err
        ? reject(err)
        : resolve(
            Buffer.concat([
              Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              chunk('IHDR', ihdr),
              chunk('IDAT', data),
              chunk('IEND', Buffer.alloc(0)),
            ])
          )
    )
  );
}

module.exports = { encodePng, encodePngGrey, crc32 };
