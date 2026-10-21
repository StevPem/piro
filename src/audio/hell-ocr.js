'use strict';

/**
 * Feld-Hell text reader: received picture columns -> text.
 *
 * Feld-Hell sends pictures of letters, not codes (see hell-tx.js), so this
 * reads the picture by matching it against the font fldigi (and PiRO)
 * send with, "hell 12" (hell-font.js). It only reads that font; other
 * fonts, wide or hand-keyed Hell come out as nothing or as rubbish. The
 * picture is still the thing to read on weak signals: the eye copes with
 * far more noise than this does.
 *
 * How it works. HellReceiver (hell-rx.js) turns each transmitted column (14
 * half-pixels) into exactly `rows` brightness samples, in time order. So the
 * picture is one long stream of samples, and a character on air is its font
 * columns with a blank column either side, `rows` samples per column. Where
 * a letter sits up or down the picture is just where it starts in the
 * stream, so there is no separate vertical search: the stream is matched as
 * a sequence of characters, each starting at any sample.
 *
 *  - Brightness is centred on a threshold halfway between the paper and ink
 *    levels of the last second or so (25th and 90th percentiles), so each
 *    sample scores + for agreeing with a template and - for not.
 *  - Every distinct font column (100 of them) is scored at every start
 *    sample; a character's score is the sum of its columns' scores.
 *  - Dynamic programming finds the best sequence of characters, blank
 *    columns and (penalised) single skipped or overlapped samples; the skips
 *    absorb the slow slant from the two stations' clocks not quite agreeing.
 *  - The best sequence is read out a few seconds behind, once later samples
 *    can no longer change it. A character is only printed if its match
 *    quality (score per sample, relative to the contrast) is good enough,
 *    which keeps noise from being printed as letters. Three or more blank
 *    columns between letters is a space.
 *
 * Several lower-case letters are drawn exactly like capitals in this font;
 * those read as capitals.
 */

const { fontColumn, COLUMN_LEN } = require('./hell-tx');

const DEFAULT_ROWS = 20;
const LAG_COLUMNS = 40; // read out about 2.3 s behind
const LEVEL_WINDOW_COLUMNS = 20; // paper/ink levels over the last ~1.1 s (short, so they follow a signal starting or fading)
const SKIP_PENALTY = 0.35; // per skipped sample (score units are brightness, 0-1)
const OVERLAP_PENALTY = 0.35;
// The squelch (see _readOut): text is printed only while it is open.
const DEFAULT_OPEN_QUALITY = 0.55; // opens on two characters in a row matching at least this well...
const DEFAULT_CLOSE_QUALITY = 0.4; // ...closes when the last few average below this,
const CLOSE_GAP_COLUMNS = 12; // or after this many columns with no character at all
const OPEN_MIN_INK = 25; // samples of ink a character needs to open it: noise specks fit . ' , - and friends too well
const DEFAULT_MIN_QUALITY = 0.4; // while open, a character must match at least this well,
const RELATIVE_MARGIN = 0.25; // and no more than this below the characters around it
const RECENT = 3; // characters that make up "the last few"
const MIN_INK_QUALITY = 0.3; // where the character has ink, the picture must be this far towards ink (0-1)
const SPACE_COLUMNS = 3; // blank columns between two letters that make a space

/** One transmitted column (14 bits, bit 0 first) rendered as `rows` samples, each the fraction of ink it covers. */
function renderColumn(bits, rows) {
  const t = new Float32Array(rows);
  const hp = COLUMN_LEN / rows; // half-pixels per sample
  for (let i = 0; i < rows; i++) {
    const a = i * hp;
    const b = (i + 1) * hp;
    let ink = 0;
    for (let k = Math.floor(a); k < Math.ceil(b) && k < COLUMN_LEN; k++) {
      const overlap = Math.min(b, k + 1) - Math.max(a, k);
      if ((bits >> k) & 1) ink += overlap;
    }
    t[i] = ink / hp;
  }
  return t;
}

/** The font as tokens: each character's column-pattern indices, blank column either side. */
function buildFont(rows) {
  const patterns = [0];
  const index = new Map([[0, 0]]);
  const chars = [];
  const seen = new Set();
  for (let code = 33; code <= 126; code++) {
    const cols = [];
    let bits;
    for (let c = 0; (bits = fontColumn(code, c)) !== -1; c++) cols.push(bits);
    if (!cols.length) continue;
    const key = cols.join(',');
    if (seen.has(key)) continue; // drawn like an earlier character (most lower case: like the capital)
    seen.add(key);
    const ids = [0];
    for (const b of cols) {
      if (!index.has(b)) {
        index.set(b, patterns.length);
        patterns.push(b);
      }
      ids.push(index.get(b));
    }
    ids.push(0);
    chars.push({ ch: String.fromCharCode(code), ids, cols, len: ids.length * rows });
  }
  const templates = patterns.map((b) => {
    const t = renderColumn(b, rows);
    const w = Float32Array.from(t, (v) => 2 * v - 1); // +1 ink, -1 paper
    let sum = 0;
    for (const v of w) sum += v;
    return { t, w, sum, ink: t.reduce((n, v) => n + v, 0) };
  });
  for (const c of chars) c.ink = c.ids.reduce((n, id) => n + templates[id].ink, 0);
  return { chars, templates };
}

class HellTextReader {
  /**
   * @param {object} [opts]
   * @param {number} [opts.rows=20] - samples per column (HellReceiver's rows)
   * @param {number} [opts.openQuality=0.55] - the squelch opens on two characters in a row this good (0-1)
   * @param {number} [opts.closeQuality=0.4] - and closes when the last few average below this
   * @param {number} [opts.minQuality=0.4] - while open, how good a character's match must be to be printed
   * @param {number} [opts.lagColumns=40] - how far behind the newest column text is read out
   * @param {number} [opts.levelColumns=20] - columns the paper and ink levels are measured over
   * @param {boolean} [opts.trace=false] - keep a record of every character read (this.trace), for tests
   */
  constructor({
    rows = DEFAULT_ROWS,
    openQuality = DEFAULT_OPEN_QUALITY,
    closeQuality = DEFAULT_CLOSE_QUALITY,
    minQuality = DEFAULT_MIN_QUALITY,
    lagColumns = LAG_COLUMNS,
    levelColumns = LEVEL_WINDOW_COLUMNS,
    trace = false,
  } = {}) {
    this.levelColumns = levelColumns;
    this.trace = trace ? [] : null; // with opts.trace: every character read, {ch, s, q, printed}
    this.rows = rows;
    this.openQuality = openQuality;
    this.closeQuality = closeQuality;
    this.minQuality = minQuality;
    this.lag = lagColumns * rows;
    const { chars, templates } = buildFont(rows);
    this.chars = chars;
    this.templates = templates;
    this.maxLen = Math.max(...chars.map((c) => c.len));
    this.reset();
  }

  reset() {
    // Everything is indexed by absolute sample number; arrays hold from `base`.
    this.base = 0;
    this.n = 0; // samples received
    this.y = []; // brightness, 0-1
    this.theta = []; // threshold at each sample
    this.contrast = []; // ink - paper at each sample
    this.cs = []; // cs[i - base]: Float32Array of every pattern's score for a column starting at sample i
    this.best = [0]; // best[e - base]: best score of a reading of samples [base, e)
    this.back = [null]; // how best[e] was reached: {s, tok} (tok: char index, -1 blank column, -2 skip)
    this.committed = 0; // samples up to here have been read out
    this.lastCharEnd = null; // end sample of the last printed character
    this.levelBuf = [];
    this.recent = []; // the last few read characters' {q, len}, for the squelch
    this.open = false; // the squelch
    this.lastTokenEnd = null; // end of the last character read (printed or not)
  }

  /** Adds received columns (each `rows` values 0-255, earliest first); returns any newly read text. */
  push(columns) {
    let text = '';
    for (const col of columns) {
      for (let i = 0; i < col.length; i++) this._sample(col[i] / 255);
      this._updateLevels(col);
      text += this._readOut(false);
    }
    return text;
  }

  /** Reads out everything so far (the signal has ended, or Feld-Hell was deselected). */
  flush() {
    return this._readOut(true);
  }

  _updateLevels(col) {
    for (const v of col) this.levelBuf.push(v / 255);
    const max = this.levelColumns * this.rows;
    if (this.levelBuf.length > max) this.levelBuf.splice(0, this.levelBuf.length - max);
    const sorted = Float32Array.from(this.levelBuf).sort();
    const paper = sorted[Math.floor(sorted.length * 0.25)];
    // At least half the 99th percentile: when a clean signal starts out of silence its ink is only
    // a small part of the window (fldigi's ". . ." preamble), and the 90th percentile is still paper.
    const ink = Math.max(sorted[Math.floor(sorted.length * 0.9)], 0.5 * sorted[Math.floor(sorted.length * 0.99)]);
    this._theta = (paper + ink) / 2;
    this._contrast = Math.max(0.05, ink - paper);
  }

  _sample(v) {
    const n = this.n++;
    this.y.push(v);
    this.theta.push(this._theta ?? 0.5);
    this.contrast.push(this._contrast ?? 0.5);
    // the column starting `rows - 1` samples ago is now complete: score every pattern there
    const s = n - this.rows + 1;
    if (s >= this.base) this.cs[s - this.base] = this._scoreColumns(s);
    // a reading can now end at sample s + rows... but tokens end anywhere: extend best[] to n + 1
    this._dp(n + 1);
  }

  _scoreColumns(s) {
    const rows = this.rows;
    const o = s - this.base;
    const th = this.theta[o + rows - 1];
    const out = new Float32Array(this.templates.length);
    for (let p = 0; p < this.templates.length; p++) {
      const { w, sum } = this.templates[p];
      let acc = 0;
      for (let i = 0; i < rows; i++) acc += w[i] * this.y[o + i];
      out[p] = acc - th * sum;
    }
    return out;
  }

  /** How far towards ink the picture is where character `c` (starting at s) has ink: 1 = fully, 0 = at the threshold. */
  _inkQuality(c, s) {
    let num = 0;
    let den = 0;
    for (let j = 0; j < c.ids.length; j++) {
      const tpl = this.templates[c.ids[j]].t;
      for (let i = 0; i < this.rows; i++) {
        if (!tpl[i]) continue;
        const o = s + j * this.rows + i - this.base;
        num += tpl[i] * (this.y[o] - this.theta[o]);
        den += (tpl[i] * this.contrast[o]) / 2;
      }
    }
    return den > 0 ? num / den : 0;
  }

  /** Token score of character `c` starting at sample s, or null if not all its columns are scored yet. */
  _charScore(c, s) {
    const rows = this.rows;
    let acc = 0;
    const ids = c.ids;
    for (let j = 0; j < ids.length; j++) {
      const col = this.cs[s + j * rows - this.base];
      if (!col) return null;
      acc += col[ids[j]];
    }
    return acc;
  }

  _dp(e) {
    const B = this.base;
    const rows = this.rows;
    let best = this.best[e - 1 - B] - SKIP_PENALTY; // skip one sample
    let back = { s: e - 1, tok: -2 };
    // one blank column
    const sb = e - rows;
    if (sb >= B && this.cs[sb - B]) {
      const v = this.best[sb - B] + this.cs[sb - B][0];
      if (v > best) {
        best = v;
        back = { s: sb, tok: -1 };
      }
    }
    for (let k = 0; k < this.chars.length; k++) {
      const c = this.chars[k];
      const s = e - c.len;
      if (s < B) continue;
      const sc = this._charScore(c, s);
      if (sc === null) continue;
      let v = this.best[s - B] + sc;
      if (v > best) {
        best = v;
        back = { s, tok: k, score: sc };
      }
      // overlapping the previous reading by one sample (the sender's clock running slow). That sample
      // is already counted in best[s + 1], so its score here (a blank column's: paper agreement) comes
      // off; otherwise overlapping would pay for itself on blank paper.
      if (s + 1 - B < this.best.length && s + 1 < e) {
        const o = s - B;
        const first = this.theta[o] - this.y[o];
        v = this.best[s + 1 - B] + sc - first - OVERLAP_PENALTY;
        if (v > best) {
          best = v;
          back = { s, tok: k, score: sc, from: s + 1 };
        }
      }
    }
    this.best[e - B] = best;
    this.back[e - B] = back;
  }

  /** Follows the best reading back from the newest sample and prints the characters now far enough behind. */
  _readOut(all) {
    const end = this.n;
    const until = all ? end : end - this.lag;
    if (until <= this.committed) return '';
    const tokens = [];
    for (let e = end; e > this.committed && e > this.base; ) {
      const b = this.back[e - this.base];
      if (!b) break;
      if (b.tok >= 0) tokens.push({ k: b.tok, s: b.s, e, score: b.score });
      e = b.from ?? b.s;
    }
    tokens.reverse();
    // quality: score per sample relative to the contrast (1 = a perfect match); and the ink alone,
    // so a fit made only of agreeing paper (a blank stretch) never counts as a character
    for (const t of tokens) {
      let con = 0;
      for (let i = t.s; i < t.e; i++) con += this.contrast[i - this.base];
      t.q = Math.min(1, t.score / (con / 2)); // over 1 only while the levels are still catching up
      t.len = t.e - t.s;
      t.inkQ = this._inkQuality(this.chars[t.k], t.s);
    }
    let text = '';
    let last = this.committed;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.e > until) break;
      // already read out (by its end: a character may overlap the last one by a sample)
      if (t.e <= this.committed) continue;
      last = t.e;
      const tr = this.trace ? { ch: this.chars[t.k].ch, s: t.s, q: t.q, printed: false } : null;
      if (tr) this.trace.push(tr);
      // The squelch. Noise gives isolated fair matches (about 0.4) to small glyphs; text gives a
      // run of good ones. A long gap with no characters (between overs) closes it.
      if (this.lastTokenEnd !== null && t.s - this.lastTokenEnd > CLOSE_GAP_COLUMNS * this.rows) this.open = false;
      this.lastTokenEnd = t.e;
      this.recent.push({ q: t.q, len: t.len });
      if (this.recent.length > RECENT) this.recent.shift();
      let qs = 0;
      let ls = 0;
      for (const a of this.recent) {
        qs += a.q * a.len;
        ls += a.len;
      }
      const avg = qs / ls;
      if (!this.open) {
        const next = tokens[i + 1];
        const big = (tok) => this.chars[tok.k].ink >= OPEN_MIN_INK;
        const ahead = next ? next.q >= this.openQuality && big(next) && next.s - t.e <= CLOSE_GAP_COLUMNS * this.rows : all && t.q >= this.openQuality + 0.1;
        if (t.q >= this.openQuality && big(t) && ahead) {
          this.open = true;
          this.recent = [{ q: t.q, len: t.len }]; // the noise before doesn't count against the text
        } else continue;
      } else if (avg < this.closeQuality) {
        this.open = false;
        continue;
      }
      // a character must also be near the quality of the text around it
      const local = this.recent.length > 1 ? avg : t.q;
      if (t.q < Math.max(this.minQuality, local - RELATIVE_MARGIN) || t.inkQ < MIN_INK_QUALITY) continue;
      if (this.lastCharEnd !== null && t.s - this.lastCharEnd >= SPACE_COLUMNS * this.rows) text += ' ';
      text += this.chars[t.k].ch;
      if (tr) tr.printed = true;
      this.lastCharEnd = t.e;
    }
    this.committed = Math.max(this.committed, all ? end : Math.min(until, Math.max(last, until - this.maxLen)));
    if (all) this.lastCharEnd = this.lastCharEnd !== null ? Math.min(this.lastCharEnd, end) : null;
    this._trim();
    return text;
  }

  /** Drops what can no longer matter, keeping enough history for the longest character. */
  _trim() {
    const keep = this.committed - 2 * this.maxLen;
    const drop = keep - this.base;
    if (drop < 4096) return;
    this.y.splice(0, drop);
    this.theta.splice(0, drop);
    this.contrast.splice(0, drop);
    this.cs.splice(0, drop);
    this.best.splice(0, drop);
    this.back.splice(0, drop);
    this.base = keep;
  }
}

module.exports = { HellTextReader, buildFont, renderColumn };
