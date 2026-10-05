'use strict';

// Converts the raw 0-255 SWR meter value (see CivDriver#getSWR()) into a
// displayed VSWR number and a color zone.
//
// Calibration points below are Icom's own documented examples for this
// CI-V command (raw 0/48/80/120 = SWR 1.0/1.5/2.0/3.0 respectively —
// see driver.js getSWR()'s doc comment for the decode this is based on).
// The 255 -> 5.0 endpoint is NOT independently documented — it's this
// project's own choice, following the user's specification that 5 is
// the maximum displayed value, extrapolated linearly from the last real
// calibration point (120 -> 3.0). Everything between real calibration
// points is linearly interpolated, not independently verified against
// a bench test with known SWR loads — see docs/civ-notes.md.
const CALIBRATION_POINTS = [
  { raw: 0, vswr: 1.0 },
  { raw: 48, vswr: 1.5 },
  { raw: 80, vswr: 2.0 },
  { raw: 120, vswr: 3.0 },
  { raw: 255, vswr: 5.0 }, // extrapolated ceiling, not independently documented
];

/** Converts a raw 0-255 SWR value into an approximate VSWR number. */
export function rawToVswr(raw) {
  const clamped = Math.max(0, Math.min(255, raw));
  for (let i = 0; i < CALIBRATION_POINTS.length - 1; i++) {
    const a = CALIBRATION_POINTS[i];
    const b = CALIBRATION_POINTS[i + 1];
    if (clamped >= a.raw && clamped <= b.raw) {
      const t = (clamped - a.raw) / (b.raw - a.raw);
      return a.vswr + t * (b.vswr - a.vswr);
    }
  }
  return CALIBRATION_POINTS[CALIBRATION_POINTS.length - 1].vswr;
}

/**
 * Color zone for a VSWR value: 'green' (<=1.5, a good match), 'orange'
 * (>1.5 and <=3, worth attention), or 'red' (>3, worth investigating).
 */
export function vswrZone(vswr) {
  if (vswr <= 1.5) return 'green';
  if (vswr <= 3) return 'orange';
  return 'red';
}
