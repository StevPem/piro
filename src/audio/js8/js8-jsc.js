'use strict';

/**
 * JSC: JS8Call's word compression for data frames. Text is cut into words
 * from a fixed list of 262,144 (common English words, callsign pieces and
 * single characters), and each word index is sent as a variable-length
 * (s,c)-dense code, s = 7, c = 9, in 4-bit pieces.
 *
 * Ported from JS8Call-improved (JS8_JSC/JSC.cpp, GPL-3.0); the word list is
 * JS8Call's JSC_map.cpp, made into jsc-words.txt.br by
 * third_party/js8call/make-wordlist.js. That script checks that the
 * lookup here (the longest listed word the text starts with) gives what
 * JS8Call's search of JSC_list.cpp gives.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 7;
const C = 16 - S; // 9
const NBITS = 4;
const SIZE = 262144;

let table = null;

/** Loads the word list (about 2 MB of text) the first time it's needed. */
function load() {
  if (table) return table;
  const raw = zlib.brotliDecompressSync(fs.readFileSync(path.join(__dirname, 'jsc-words.txt.br')));
  const words = raw.toString('latin1').split('\n');
  words.length = SIZE;
  words[69] = '\n';
  words[72] = '\x1a';
  // What JS8Call's compressor steps over for each word: its length, but for
  // two entries whose listed size differs (kept, to send what JS8Call sends).
  const sizes = Int32Array.from(words, (w) => w.length);
  sizes[81] = 7; // @ALLCALL (it can't be found by the search anyway)
  sizes[262143] = 1; // ROSIDS
  const index = new Map();
  let maxLen = 0;
  for (let i = 0; i < SIZE; i++) {
    if (i === 81) continue;
    index.set(words[i], i);
    if (words[i].length > maxLen) maxLen = words[i].length;
  }
  table = { words, sizes, index, maxLen };
  return table;
}

/** The index of the longest listed word that `w` starts with, or -1. */
function lookup(w) {
  const { index, maxLen } = load();
  for (let len = Math.min(maxLen, w.length); len > 0; len--) {
    const i = index.get(w.slice(0, len));
    if (i !== undefined) return i;
  }
  return -1;
}

function intToBits(value, n) {
  const bits = new Array(n).fill(0);
  for (let i = n - 1; i >= 0 && value > 0; i--) {
    bits[i] = value % 2;
    value = Math.floor(value / 2);
  }
  return bits;
}

/** The code for word `index`; `separate` means a space follows the word. */
function codeword(index, separate) {
  const out = [intToBits(((index % S) << 1) + (separate ? 1 : 0), NBITS + 1)];
  let x = Math.floor(index / S);
  while (x > 0) {
    x -= 1;
    out.unshift(intToBits((x % C) + S, NBITS));
    x = Math.floor(x / C);
  }
  return out.flat();
}

/**
 * Compresses text: [{bits, chars}], one per word piece, where chars is how
 * much of the text it covers (a following space included). A word with a
 * character the list can't make is cut off there, as in JS8Call.
 */
function compress(text) {
  const { sizes } = load();
  const out = [];
  const parts = text.split(' ');
  for (let i = 0; i < parts.length; i++) {
    let w = parts[i];
    const isLastWord = i === parts.length - 1;
    let isSpace = false;
    if (w === '' && !isLastWord) {
      w = ' ';
      isSpace = true;
    }
    while (w !== '') {
      const idx = lookup(w);
      if (idx < 0) break;
      w = w.slice(sizes[idx]);
      const appendSpace = w === '' && !isSpace && !isLastWord;
      out.push({ bits: codeword(idx, appendSpace), chars: sizes[idx] + (appendSpace ? 1 : 0) });
    }
  }
  return out;
}

/** Decompresses bits (an array of 0/1) to text. */
function decompress(bits) {
  const { words } = load();
  const base = [0];
  for (let k = 1; k < 8; k++) base[k] = base[k - 1] + S * Math.pow(C, k - 1);
  const bytes = [];
  const separators = [];
  let i = 0;
  while (i < bits.length) {
    if (i + 4 > bits.length) break;
    const byte = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    bytes.push(byte);
    i += 4;
    if (byte < S) {
      if (bits.length - i > 0 && bits[i]) separators.push(bytes.length - 1);
      i += 1;
    }
  }
  let out = '';
  let start = 0;
  while (start < bytes.length) {
    let k = 0;
    let j = 0;
    while (start + k < bytes.length && bytes[start + k] >= S) {
      j = j * C + (bytes[start + k] - S);
      k++;
    }
    if (j >= SIZE) break;
    if (start + k >= bytes.length) break;
    j = j * S + bytes[start + k] + base[k];
    if (j >= SIZE) break;
    out += words[j];
    if (separators.length && separators[0] === start + k) {
      out += ' ';
      separators.shift();
    }
    start += k + 1;
  }
  return out;
}

/** The characters JSC can make on their own (the list's single-character words). */
function singleChars() {
  const { words } = load();
  return words.filter((w) => w.length === 1);
}

module.exports = { compress, decompress, lookup, codeword, singleChars, load };
