'use strict';

/**
 * Speech-to-text "copy assist": what PiRO keeps from whisper.cpp's answer,
 * and the callsigns it finds in it.
 *
 * Whisper was trained on clean, wideband speech. On HF SSB it does well on
 * strong signals, poorly near the noise floor, and on noise alone it can
 * make up text ("Thank you for watching."). So:
 * - a segment is dropped as silence by Whisper's own rule: no_speech_prob
 *   over 0.6 *and* average log-probability under -1 (OpenAI's
 *   transcribe(); either alone is common on real speech over SSB);
 * - text Whisper is known to invent from noise (captions, "subscribe",
 *   [BLANK_AUDIO], music marks) is dropped;
 * - a phrase repeated over and over (Whisper's decoding loop) is cut to one;
 * - each word keeps its probability, so the page can grey the doubtful ones.
 *
 * Callsigns: Whisper writes phonetics as words ("Victor Kilo Three Tango
 * Romeo"). phoneticCallsigns() turns runs of phonetic words, number words,
 * single letters and digits into callsigns ("VK3TR"), and also finds
 * callsigns written as such.
 */

const NO_SPEECH_MAX = 0.6;
const AVG_LOGPROB_MIN = -1.0;
const LOW_WORD_P = 0.4;

/** The prompt Whisper is given: the words of a QSO, so it expects them. */
const HAM_PROMPT =
  'Amateur radio contact on HF. CQ CQ, this is Victor Kilo Three Alpha Bravo Charlie, VK3ABC. ' +
  'You are five nine, QTH Melbourne, name is Steve. QSL, QRZ, 73, over.';

const INVENTED = [
  /thank(s| you) for watching/i,
  /please (like|subscribe)/i,
  /\bsubscribe\b/i,
  /subtitles? (by|from)/i,
  /captions? by/i,
  /amara\.org/i,
  /♪/,
  /^\s*[[(].*[\])]\s*$/, // [BLANK_AUDIO], (static), [Music]
];

/** True if a segment's text is something Whisper makes up from noise. */
function isInvented(text) {
  const t = String(text || '').trim();
  if (!t || /^[.\s,!?-]*$/.test(t)) return true;
  return INVENTED.some((re) => re.test(t));
}

/** "a b c a b c a b c a b c" -> "a b c": Whisper's repetition loop. */
function collapseRepeats(text) {
  const words = text.split(/\s+/).filter(Boolean);
  for (let len = 1; len <= Math.floor(words.length / 3); len++) {
    for (let start = 0; start + 3 * len <= words.length; start++) {
      const unit = words.slice(start, start + len).join(' ').toLowerCase();
      let reps = 1;
      while (start + (reps + 1) * len <= words.length && words.slice(start + reps * len, start + (reps + 1) * len).join(' ').toLowerCase() === unit) reps++;
      if (reps >= 3) {
        const kept = [...words.slice(0, start + len), ...words.slice(start + reps * len)];
        return collapseRepeats(kept.join(' '));
      }
    }
  }
  return words.join(' ');
}

/**
 * The text to show from a verbose_json answer: {text, words: [{w, p}],
 * dropped, why} where dropped counts segments left out and why says why
 * (for the log).
 */
function keepSegments(answer) {
  const segments = Array.isArray(answer?.segments) ? answer.segments : [];
  const parts = [];
  const words = [];
  let dropped = 0;
  const why = []; // what was dropped and why, for the log
  for (const seg of segments) {
    const text = String(seg.text || '').trim();
    const noSpeech = Number(seg.no_speech_prob);
    const avg = Number(seg.avg_logprob);
    const silence = Number.isFinite(noSpeech) && noSpeech > NO_SPEECH_MAX && Number.isFinite(avg) && avg < AVG_LOGPROB_MIN;
    if (silence || isInvented(text)) {
      dropped++;
      why.push(`${silence ? `silence (no_speech ${noSpeech.toFixed(2)}, avg_logprob ${avg.toFixed(2)})` : 'invented'}: "${text.slice(0, 60)}"`);
      continue;
    }
    parts.push(text);
    // whisper.cpp's "words" are tokens: pieces that start with a space begin a word.
    let current = null;
    for (const tok of Array.isArray(seg.words) ? seg.words : []) {
      const piece = String(tok.word ?? '');
      if (!piece || /^\[_|^<\|/.test(piece.trim())) continue;
      const p = Number.isFinite(tok.probability) ? tok.probability : 1;
      if (!current || /^\s/.test(piece)) {
        current = { w: piece.trim(), p };
        words.push(current);
      } else {
        current.w += piece;
        current.p = Math.min(current.p, p);
      }
    }
  }
  const raw = parts.join(' ').replace(/\s+/g, ' ').trim();
  const text = collapseRepeats(raw);
  // If repeats were cut, the per-word list no longer lines up: show the words plain.
  const shown = text === raw && words.length ? words.filter((x) => x.w) : text ? text.split(' ').map((w) => ({ w, p: 1 })) : [];
  return { why, text, words: shown.map((x) => (x.p < LOW_WORD_P ? { w: x.w, p: Math.round(x.p * 100) / 100, low: true } : { w: x.w, p: Math.round(x.p * 100) / 100 })), dropped };
}

const PHONETIC = {
  alpha: 'A',
  alfa: 'A',
  bravo: 'B',
  charlie: 'C',
  delta: 'D',
  echo: 'E',
  foxtrot: 'F',
  fox: 'F',
  golf: 'G',
  hotel: 'H',
  india: 'I',
  juliet: 'J',
  juliett: 'J',
  kilo: 'K',
  lima: 'L',
  mike: 'M',
  november: 'N',
  oscar: 'O',
  papa: 'P',
  quebec: 'Q',
  romeo: 'R',
  sierra: 'S',
  tango: 'T',
  uniform: 'U',
  victor: 'V',
  whiskey: 'W',
  whisky: 'W',
  xray: 'X',
  'x-ray': 'X',
  yankee: 'Y',
  zulu: 'Z',
};
const NUMBER = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9' };
const CALLSIGN_RE = /^(?=[A-Z0-9]*[A-Z])[A-Z0-9]{1,3}\d[A-Z]{1,4}$/;
const STROKE = new Set(['stroke', 'slash', 'portable', 'mobile']);

/** Callsigns in some text, spelled out phonetically or written as such, in order, each once. */
function phoneticCallsigns(text) {
  const found = [];
  const add = (c) => {
    if (CALLSIGN_RE.test(c) && !found.includes(c)) found.push(c);
  };
  const tokens = String(text || '')
    .replace(/x-ray/gi, 'xray')
    .split(/[\s,.;:!?"]+|(?<=[a-z])-(?=[a-z])/i)
    .filter(Boolean);
  let run = '';
  let phonetics = 0;
  const flush = () => {
    if (run.length >= 3 && phonetics >= 2) {
      // a call said twice ("victor kilo three tango romeo victor kilo three ...") runs together
      const half = run.length % 2 === 0 && run.slice(0, run.length / 2) === run.slice(run.length / 2) ? run.slice(0, run.length / 2) : run;
      for (let len = Math.min(half.length, 8); len >= 3; len--) {
        let hit = false;
        for (let i = 0; i + len <= half.length; i++) {
          if (CALLSIGN_RE.test(half.slice(i, i + len))) {
            add(half.slice(i, i + len));
            hit = true;
            break;
          }
        }
        if (hit) break;
      }
    }
    run = '';
    phonetics = 0;
  };
  for (const raw of tokens) {
    const tok = raw.replace(/[^A-Za-z0-9-]/g, '');
    const low = tok.toLowerCase();
    if (/^[A-Z0-9]{3,8}$/.test(tok) && CALLSIGN_RE.test(tok)) {
      flush();
      add(tok);
    } else if (PHONETIC[low]) {
      run += PHONETIC[low];
      phonetics++;
    } else if (NUMBER[low] && run) {
      run += NUMBER[low];
    } else if (/^\d{1,2}$/.test(tok) && run) {
      run += tok;
    } else if (/^[A-Z]{1,2}\d?$|^\d[A-Z]{1,3}$/.test(tok) && (run || phonetics === 0)) {
      // "VK 3 TR", "VK3 Tango Romeo": short capitals and digits join a run
      run += tok;
      if (/\d/.test(tok) || tok.length >= 2) phonetics++;
    } else if (STROKE.has(low)) {
      flush();
    } else {
      flush();
    }
  }
  flush();
  return found;
}

module.exports = { keepSegments, phoneticCallsigns, isInvented, collapseRepeats, HAM_PROMPT, NO_SPEECH_MAX, AVG_LOGPROB_MIN, LOW_WORD_P };
