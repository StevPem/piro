'use strict';

// The meter under the frequency shows one of three things, picked by
// tapping its title: the S-meter, SWR or ALC. Each has its own 16-segment
// reading and its own legend under the segments. Pure functions, so the
// tests can run them in Node (test/meter-modes.test.mjs).
//
// - S-meter: the radio's S-meter (smeter.js). While you transmit it shows
//   SWR instead, as it always has: the S-meter reads nothing then.
// - SWR: 1.0 to 5.0 (vswr.js), while transmitting.
// - ALC: CI-V 15 13, 0 (minimum) to 120 (maximum) per Icom's CI-V
//   reference, shown as a percent of that, while transmitting.

import { S_METER_LEVELS, sMeterLevelIndex, sMeterLabel } from './smeter.js';
import { rawToVswr, vswrZone } from './vswr.js';

export const METER_MODES = ['S', 'SWR', 'ALC'];
export const METER_TITLES = { S: 'S-meter', SWR: 'SWR', ALC: 'ALC' };
export const METER_SEGMENTS = S_METER_LEVELS.length; // 16

const ALC_MAX_RAW = 120;

/** The mode after `mode` when the title is tapped. */
export function nextMeterMode(mode) {
  const i = METER_MODES.indexOf(mode);
  return METER_MODES[(i + 1) % METER_MODES.length];
}

/** What the meter shows: SWR while transmitting in the S-meter mode, else the mode itself. */
export function shownMeter(mode, transmitting) {
  if (mode === 'S') return transmitting ? 'SWR' : 'S';
  return METER_MODES.includes(mode) ? mode : 'S';
}

// SWR: each segment is 0.25 of SWR; segment i lights from 1 + 0.25 (i + 0.5).
// Labels where the scale is a round number.
const SWR_LABELS = { 1: '1.5', 3: '2', 5: '2.5', 7: '3', 11: '4', 15: '5' };
// ALC: each segment is 1/16 of the scale.
const ALC_LABELS = { 3: '25%', 7: '50%', 11: '75%', 15: '100%' };

/** The 16 labels under the segments for what is shown ('S', 'SWR' or 'ALC'). */
export function meterLegend(shown) {
  if (shown === 'SWR') return Array.from({ length: METER_SEGMENTS }, (_, i) => SWR_LABELS[i] ?? '');
  if (shown === 'ALC') return Array.from({ length: METER_SEGMENTS }, (_, i) => ALC_LABELS[i] ?? '');
  return S_METER_LEVELS.map((l) => l.barLabel);
}

/** ALC raw reading to a percent of the scale (over 100 if the radio reports more than 120). */
export function alcPercent(raw) {
  return Math.round((Math.max(0, Math.min(255, raw)) / ALC_MAX_RAW) * 100);
}

/**
 * The reading: {text, segments}, segments being one colour per segment:
 * null (off), 'green', 'amber' or 'red'.
 */
export function meterReading(shown, raw) {
  const n = METER_SEGMENTS;
  if (shown === 'SWR') {
    const vswr = rawToVswr(raw);
    const zone = vswrZone(vswr);
    const lit = Math.round(((vswr - 1) / 4) * n);
    const colour = zone === 'orange' ? 'amber' : zone;
    return { text: `SWR ${vswr.toFixed(1)}`, segments: Array.from({ length: n }, (_, i) => (i < lit ? colour : null)) };
  }
  if (shown === 'ALC') {
    const pct = alcPercent(raw);
    const lit = Math.min(n, Math.round((pct / 100) * n));
    return { text: `ALC ${pct}%`, segments: Array.from({ length: n }, (_, i) => (i < lit ? (pct > 100 ? 'red' : 'green') : null)) };
  }
  const idx = sMeterLevelIndex(raw);
  return {
    text: sMeterLabel(raw),
    segments: S_METER_LEVELS.map((l, i) => (i <= idx ? (l.over ? 'red' : 'green') : null)),
  };
}
