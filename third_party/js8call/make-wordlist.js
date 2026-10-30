#!/usr/bin/env node
'use strict';

/**
 * Makes src/audio/js8/jsc-words.txt.br from JS8Call-improved's JSC tables.
 *
 *   node third_party/js8call/make-wordlist.js JS8CALL_SOURCE_DIR [OUTPUT]
 *
 * Reads JS8_JSC/JSC_map.cpp (the 262,144 words, by index) and
 * JS8_JSC/JSC_list.cpp (the same words in search order, and the prefix
 * table). It checks that PiRO's lookup (the longest word the text starts
 * with, see src/audio/js8/js8-jsc.js) finds what JS8Call's does, then
 * writes the words one a line, by index, in Latin-1, brotli-compressed.
 * Two words can't be a line: index 69 (a newline) and index 72 (0x1A).
 * Their lines are left empty and js8-jsc.js fills them in.
 */

const fs = require('fs');
const zlib = require('zlib');

const ENTRY = /\{("(?:[^"\\]|\\.)*")(?:\s*\/\*[\s\S]*?\*\/)?\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g;

function unescapeC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|n|"|\\|')/g, (_, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return { n: '\n', '"': '"', '\\': '\\', "'": "'" }[e];
  });
}

function tables(file, marker) {
  const text = fs.readFileSync(file, 'latin1');
  return text
    .split(marker)
    .slice(1)
    .map((part) => {
      const body = part.split('\n};')[0];
      return [...body.matchAll(ENTRY)].map((m) => [unescapeC(m[1].slice(1, -1)), Number(m[2]), Number(m[3])]);
    });
}

function check(cond, what) {
  if (!cond) throw new Error(`check failed: ${what}`);
}

const src = process.argv[2];
const dest = process.argv[3] || 'src/audio/js8/jsc-words.txt.br';
if (!src) {
  console.error('usage: make-wordlist.js JS8CALL_SOURCE_DIR [OUTPUT]');
  process.exit(2);
}
const [words] = tables(`${src}/JS8_JSC/JSC_map.cpp`, 'JSC::map[');
const [search, prefix] = tables(`${src}/JS8_JSC/JSC_list.cpp`, 'JSC::');
check(words.length === 262144 && words.every((w, i) => w[2] === i), 'map is the words by index');
check(search.every((e) => words[e[2]][0] === e[0]), 'list entries name map words');
// Within each prefix group a word comes before any shorter word that starts
// it, so JS8Call's first match is the longest one.
for (const [ch, count, start] of prefix) {
  const group = search.slice(start, start + count).filter((e) => e[0][0] === ch).map((e) => e[0]);
  const pos = new Map(group.map((w, i) => [w, i]));
  for (const w of group) {
    for (let k = 1; k < w.length; k++) check(!(pos.has(w.slice(0, k)) && pos.get(w.slice(0, k)) < pos.get(w)), `order of ${w}`);
  }
  if (count === 1) check(search[start][0] === ch, `single-character group ${ch}`);
}
// The only word no prefix group reaches is @ALLCALL (index 81).
const reached = new Set();
for (const [ch, count, start] of prefix) {
  for (const e of search.slice(start, start + count)) if (words[e[2]][0][0] === ch) reached.add(e[2]);
}
check(reached.size === words.length - 1 && !reached.has(81), 'only @ALLCALL is unreachable');

const lines = words.map(([w], i) => {
  if (i === 69 || i === 72) return '';
  check(w !== '' && !w.includes('\n'), `word ${i} fits a line`);
  return w;
});
const raw = Buffer.from(`${lines.join('\n')}\n`, 'latin1');
const out = zlib.brotliCompressSync(raw, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
  },
});
fs.writeFileSync(dest, out);
const odd = words.map(([w, size], i) => [i, w, size]).filter(([, w, size]) => size !== w.length);
console.log(`${dest}: ${words.length} words, ${raw.length} bytes, ${out.length} compressed.`);
console.log('Sizes that differ from the word:', JSON.stringify(odd));
