// Spots FT8/FT4 messages addressed to this station ("VK3TR K1ABC FN42"),
// so the page can chime when someone calls. Pure logic, no DOM: see the
// 'ft8-decodes' listener in app.js for the sound.
//
// Rules (after TX-5DR's client notifications):
// - Only a directed message counts: its first callsign is ours and the
//   sender is someone else. CQs, other people's QSOs, free text and
//   anything we can't parse don't.
// - Each caller alerts once, then stays quiet while they keep calling
//   (every message from them renews a 2-minute window). After 2 minutes
//   with nothing from them, a new call alerts again.
// - A slot alerts at most once, however many people call in it.
// - Old or repeated slots never re-arm a caller.

import { parseFt8Message } from './ft8-qso.js';

export const CALL_ALERT_WINDOW_MS = 2 * 60 * 1000;

/** "<VK3TR>" -> "VK3TR"; "VK3TR/P" -> "VK3TR" (so a portable call still matches). */
export function baseCall(call) {
  const c = String(call || '').toUpperCase().replace(/^<|>$/g, '');
  const parts = c.split('/');
  // the longest part with a digit is the call itself (prefix and suffix are short)
  return parts.filter((p) => /\d/.test(p)).sort((a, b) => b.length - a.length)[0] || c;
}

export class CallAlert {
  constructor({ windowMs = CALL_ALERT_WINDOW_MS } = {}) {
    this.windowMs = windowMs;
    this._last = new Map(); // caller -> slot start (ms) last heard calling us
  }

  /**
   * One slot's decodes. Returns the callers that should alert now (newest
   * calls first in decode order); an empty array means stay quiet.
   * @param {Array<{msg: string}>} messages
   * @param {number} slotStartMs
   * @param {string} myCall
   */
  check(messages, slotStartMs, myCall) {
    const me = baseCall(myCall);
    if (!me || !Number.isFinite(slotStartMs)) return [];
    const fresh = [];
    for (const m of messages || []) {
      const p = parseFt8Message(m?.msg);
      if (p.isCq || !p.toCall || !p.fromCall) continue;
      if (baseCall(p.toCall) !== me) continue;
      const from = baseCall(p.fromCall);
      if (!from || from === me || from === '...') continue;
      const last = this._last.get(from);
      if (last != null && slotStartMs <= last) continue; // replayed or out of order
      if (last == null || slotStartMs - last > this.windowMs) fresh.push(from);
      this._last.set(from, slotStartMs);
    }
    // forget callers long gone, so this stays small
    for (const [call, t] of this._last) if (slotStartMs - t > 2 * this.windowMs) this._last.delete(call);
    return [...new Set(fresh)];
  }

  /** Forget everyone (e.g. leaving FT8). */
  reset() {
    this._last.clear();
  }
}
