'use strict';

// Real calibration data — a reference table mapping the raw CI-V S-meter
// value (0-255) to target S-unit readings, supplied directly by the
// user, derived from a power-curve fit against individual S-values
// (superseding an earlier table that could only distinguish "S1-S3" as
// one combined range) — applied exactly as given (see docs/ui-notes.md
// for the fuller history, including the earlier even-spacing
// placeholder used before any calibration data was available).
//
// `threshold` is the lower (inclusive) bound of each range, taken
// directly from the table. Note: the source table's S0 row read "0-10"
// and S1's read "10-19" — technically overlapping at 10 — but since this
// bucket system only ever needs each level's lower bound (it finds the
// highest threshold a value meets or exceeds), S1's unambiguous start
// (10) is all that's needed to fully determine where S0 ends; no
// judgment call about the overlap was actually required.
//
// `over` marks the six "over S9" buckets, which get a visually distinct
// (red, vs. green) treatment in the bar.
export const S_METER_LEVELS = [
  { label: 'S0', barLabel: 'S0', threshold: 0, over: false },
  { label: 'S1', barLabel: 'S1', threshold: 10, over: false },
  { label: 'S2', barLabel: 'S2', threshold: 20, over: false },
  { label: 'S3', barLabel: 'S3', threshold: 30, over: false },
  { label: 'S4', barLabel: 'S4', threshold: 44, over: false },
  { label: 'S5', barLabel: 'S5', threshold: 57, over: false },
  { label: 'S6', barLabel: 'S6', threshold: 75, over: false },
  { label: 'S7', barLabel: 'S7', threshold: 90, over: false },
  { label: 'S8', barLabel: 'S8', threshold: 111, over: false },
  { label: 'S9', barLabel: 'S9', threshold: 126, over: false },
  { label: 'S9 + 10dB', barLabel: '+10', threshold: 141, over: true },
  { label: 'S9 + 20dB', barLabel: '+20', threshold: 166, over: true },
  { label: 'S9 + 30dB', barLabel: '+30', threshold: 191, over: true },
  { label: 'S9 + 40dB', barLabel: '+40', threshold: 211, over: true },
  { label: 'S9 + 50dB', barLabel: '+50', threshold: 231, over: true },
  { label: 'S9 + 60dB', barLabel: '+60', threshold: 246, over: true },
];

/** Index into S_METER_LEVELS for a given raw value (clamped to 0-255). */
export function sMeterLevelIndex(rawValue) {
  const raw = Math.max(0, Math.min(255, rawValue));
  let idx = 0;
  for (let i = 0; i < S_METER_LEVELS.length; i++) {
    if (raw >= S_METER_LEVELS[i].threshold) idx = i;
  }
  return idx;
}

/** Full display label for a raw value, e.g. "S7" or "S9 + 20dB". */
export function sMeterLabel(rawValue) {
  return S_METER_LEVELS[sMeterLevelIndex(rawValue)].label;
}
