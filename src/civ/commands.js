'use strict';

/**
 * CI-V command bytes used by this driver. Only the subset needed for core
 * rig control is defined here; scope/spectrum commands (0x27 and friends)
 * are deliberately left out for now and will be added in a later phase.
 */
const CMD = {
  TRANSCEIVE_FREQ: 0x00, // unsolicited: rig pushes frequency change
  TRANSCEIVE_MODE: 0x01, // unsolicited: rig pushes mode change
  SEND_FREQ: 0x03, // read operating frequency
  SEND_MODE: 0x04, // read operating mode
  SET_FREQ: 0x05, // set operating frequency
  SET_MODE: 0x06, // set operating mode
  LEVEL: 0x14, // various continuous level settings; see LEVEL_SUBCMD
  READ_SMETER: 0x15, // paired with SUBCMD.SMETER
  READ_TRANSCEIVER_ID: 0x19, // paired with SUBCMD.TRANSCEIVER_ID, for address auto-detect
  PTT: 0x1c, // paired with SUBCMD.PTT
  FUNCTION: 0x16, // various RX function toggles; see FUNCTION_SUBCMD
  OPTIONAL: 0x1a, // Icom's large "optional command" group: extended settings and DATA mode — see OPTIONAL_SUBCMD
  SEND_CW: 0x17, // send text with the radio's own CW keyer (up to 30 characters per command; FF = stop). See CivDriver#sendCw
  SCOPE: 0x27, // spectrum scope; see SCOPE_SUBCMD and src/civ/scope.js

  // Reply-only pseudo-commands: the rig echoes the original command byte
  // in most replies, but simple set operations reply with just OK/NG.
  OK: 0xfb,
  NG: 0xfa,
};

/**
 * Sub-commands under CMD.LEVEL (0x14) — continuous 2-byte ("00 00 to
 * 02 55") level settings, per Icom's official CI-V reference manual.
 * RF_PWR and RF_GAIN are currently used by this project.
 *
 * Byte encoding: both fields use the same "hundreds-digit nibble + BCD
 * byte" packing already hardware-confirmed for S-meter/SWR (see
 * docs/civ-notes.md), not the standard little-endian BCD pair used
 * elsewhere in this project (frequency, RIT). This is reasoned, not
 * purely guessed: `setTxPower()`'s first attempt used standard BCD and
 * was rejected outright (NG) on real hardware, and switching to this
 * meter-style packing is the current fix — but that fix itself hasn't
 * yet been confirmed against real hardware to actually resolve the
 * rejection (see driver.js's doc comment on `setTxPower()`).
 * `setRxGain()`/`getRxGain()` apply the same packing from the start, on
 * the reasoning that a sibling field in the exact same command group
 * very likely shares its encoding — one inference layered on another,
 * not independently verified for RF_GAIN specifically. Still: starting
 * from the encoding already known to be wrong for the sibling field
 * would be a worse default than this.
 */
const LEVEL_SUBCMD = {
  CW_PITCH: 0x09, // 0000=300Hz, 0128=600Hz, 0255=900Hz; linear, 5Hz steps
  KEY_SPEED: 0x0c, // the CW keyer's speed, 0000=6 WPM to 0255=48 WPM (see KEY_SPEED_TABLE)
  RF_GAIN: 0x02, // "RF gain" position — this project's RX gain control
  RF_PWR: 0x0a, // 00 00=max CCW (min power), 02 55=max CW (max power)
};

const SCOPE_SUBCMD = {
  WAVEFORM_DATA: 0x00, // send/read; also the unsolicited push once enabled
  ON_OFF: 0x10, // 00=off, 01=on — the rig's own scope display
  DATA_OUTPUT: 0x11, // 00=off, 01=on — whether waveform data is sent to the controller
  MODE: 0x14, // 00=Center, 01=Fixed, 02=Scroll-C, 03=Scroll-F
  SPAN: 0x15, // Center/Scroll-C mode span, Hz — one of SCOPE_SPAN_PRESETS_HZ only
};

// The radio only accepts these exact span values (Hz) for command 27 15 —
// not a freely settable value. See src/civ/driver.js#setScopeSpan.
// The SET command (27 15, single data byte) selects one of these 8
// presets *by array index* — e.g. sending byte 0x05 selects index 5
// (200000 Hz / "+/-100kHz" in Icom's own UI labeling, which describes
// the half-width; these values are the full width actually applied).
// Verified against a real worked example (SET/READ both), not reasoned
// from documentation alone — see docs/civ-notes.md.
// The radio's 8 fixed span presets (direct Hz values). Confirmed against
// Icom's own official IC-7300 CI-V reference manual (Section 19, p.19-14
// "Scope span settings" table), which explicitly lists these exact
// values against their "Span (kHz)" column (2.5/5/10/25/50/100/250/500)
// — direct values, NOT an index and NOT half-widths needing doubling
// (an earlier, less authoritative online source claimed both of those,
// incorrectly — see docs/civ-notes.md for the full history).
const SCOPE_SPAN_PRESETS_HZ = [2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];

const SCOPE_MODE = {
  CENTER: 0x00,
  FIXED: 0x01,
  SCROLL_C: 0x02,
  SCROLL_F: 0x03,
};

const SUBCMD = {
  SMETER: 0x02,
  SWR: 0x12, // paired with CMD.READ_SMETER — see docs/civ-notes.md
  PTT: 0x00,
  TRANSCEIVER_ID: 0x00,
  // Antenna tuner, under the same command group (0x1C) as PTT. Confirmed
  // against Icom's official IC-7300 CI-V reference manual (Section 19,
  // command table row "1C 01*"): listed as plain "00 to 02" with no page
  // reference — per the established rule (see FUNCTION_SUBCMD below), a
  // genuinely simple single-byte value: 00=tuner OFF, 01=tuner ON,
  // 02=start tuning (a one-shot trigger, not a persistent state — see
  // CivDriver#setTuner's doc comment).
  TUNER: 0x01,
};

/**
 * Sub-commands under CMD.FUNCTION (0x16) — various simple RX function
 * toggles. Confirmed against Icom's official IC-7300 CI-V reference
 * manual (Section 19, command table): all listed as plain "00/01" (or,
 * for PREAMP, "00 to 02") directly in the table with no page reference —
 * per the same rule that correctly distinguished 1-byte from 2-byte scope
 * sub-commands (see docs/civ-notes.md), the absence of a page reference
 * means these are genuinely simple single-byte values, not the 2-byte
 * "[0x00, value]" structure some other commands in this command group
 * family turned out to need.
 *
 * NOTCH maps to AUTO_NOTCH (0x41) rather than MANUAL_NOTCH (0x48) — both
 * exist and both are simple on/off toggles per the manual, but manual
 * notch only does something once the NOTCH knob is also turned, whereas
 * auto notch is a passive toggle that works on its own — a closer match
 * to how NR/NB/Preamp behave as simple on/off toggles.
 */
const FUNCTION_SUBCMD = {
  PREAMP: 0x02, // 00=OFF, 01=Preamp 1 ON, 02=Preamp 2 ON
  NOISE_BLANKER: 0x22, // 00=OFF, 01=ON
  NOISE_REDUCTION: 0x40, // 00=OFF, 01=ON
  AUTO_NOTCH: 0x41, // 00=OFF, 01=ON — see note above on NOTCH vs MANUAL_NOTCH
  MANUAL_NOTCH: 0x48, // 00=OFF, 01=ON — not used by this project's UI, kept for reference
  BREAK_IN: 0x47, // CW break-in: 00=OFF, 01=semi, 02=full. The radio only transmits CI-V CW (CMD.SEND_CW) with it on
};

/**
 * The CW keyer speed's 0-255 values for 6-48 WPM, as Hamlib's Icom backend
 * has them (rigs/icom/icom.c `cw_lookup`): [raw, wpm]. Nearly linear, but
 * not exactly, so the table is used rather than a formula.
 */
const KEY_SPEED_TABLE = [
  [0, 6], [7, 7], [12, 8], [19, 9], [25, 10], [31, 11], [37, 12], [43, 13], [49, 14], [55, 15], [61, 16],
  [67, 17], [73, 18], [79, 19], [84, 20], [91, 21], [97, 22], [103, 23], [108, 24], [114, 25], [121, 26],
  [128, 27], [134, 28], [140, 29], [144, 30], [151, 31], [156, 32], [164, 33], [169, 34], [175, 35], [182, 36],
  [188, 37], [192, 38], [199, 39], [203, 40], [211, 41], [215, 42], [224, 43], [229, 44], [234, 45], [239, 46],
  [244, 47], [250, 48],
];

/** WPM (6-48, rounded and clamped) -> the radio's 0-255 key speed value. */
function wpmToKeySpeed(wpm) {
  const w = Math.max(6, Math.min(48, Math.round(Number(wpm) || 6)));
  return KEY_SPEED_TABLE[w - 6][0];
}

/** The radio's 0-255 key speed value -> the nearest WPM. */
function keySpeedToWpm(raw) {
  let best = KEY_SPEED_TABLE[0];
  for (const e of KEY_SPEED_TABLE) if (Math.abs(e[0] - raw) < Math.abs(best[0] - raw)) best = e;
  return best[1];
}

/**
 * Sub-commands under CMD.OPTIONAL (0x1A), a large model-specific group.
 *
 *   PARAMS (0x05): the radio's extended settings ("menu items"), each
 *     selected by a 2-byte parameter number sent as the first two data
 *     bytes (see the *_PARAM_BYTES constants below), then its value.
 *   DATA_MODE (0x06): DATA mode and its filter, two data bytes: [data
 *     (00 = off, 01 = on, i.e. USB-D / LSB-D), filter (01-03; 00 when data
 *     is off)]. This is what Icom's CI-V reference and Hamlib's icom
 *     backend (S_MEM_DATA_MODE, used for every modern Icom including the
 *     IC-7300) use.
 *
 * Real bug, found from an SSTV transmission with no RF output: DATA mode
 * used to be set with `1A 05 00 63`, which on the IC-7300 is not DATA mode
 * but one of the ACC/USB output settings in the same numbered group as
 * 00 59 (AF/IF output select), 00 60 (AF output level) and 00 65 (USB MOD
 * level). The radio accepted it, so nothing failed, but DATA mode never
 * came on: the radio kept taking TX audio from its DATA OFF MOD source
 * (MIC/ACC by default), so FT8, RTTY AFSK, JTTY, Olivia, Feld-Hell and
 * SSTV keyed the transmitter with no audio. See docs/civ-notes.md.
 */
const OPTIONAL_SUBCMD = {
  PARAMS: 0x05,
  DATA_MODE: 0x06,
};

// Two more parameter numbers in the same "1A 05" sub-group, both genuine
// 0-255 continuous levels — the
// radio's own internal level settings for its USB audio codec, distinct
// from both the front-panel volume knob and this project's own ALSA-side
// `amixer` capture/playback gain maximization (see docs/audio-notes.md;
// both matter for a clean end-to-end audio path, one on the Linux side,
// one inside the radio itself):
//
//   AF_OUTPUT_LEVEL_USB (param 00 60): "AF output level to ACC/USB" —
//     how loud the radio's own RX audio is when it reaches the USB (and
//     ACC) audio output.
//   MOD_INPUT_LEVEL_USB (param 00 65): "MOD input level from USB" — how
//     sensitive the radio is to audio arriving over USB as a modulation
//     source (i.e. this app's own FT8/voice TX audio).
//
// Given directly by the operator from a real IC-7300, along with a
// worked example setting both to 02 55 (255, max) via
// CivDriver#_encodeMeterValue()'s packing — the same "hundreds-digit
// nibble + BCD byte" 0-255 encoding already hardware-confirmed for
// S-meter/TX power/RX gain. See
// CivDriver#setAfOutputLevelUsb()/setModInputLevelUsb() for how these are
// used (maxed once at server startup, to work around the USB audio
// levels the README already flags as resetting on every restart).
const AF_OUTPUT_LEVEL_USB_PARAM_BYTES = [0x00, 0x60];
const MOD_INPUT_LEVEL_USB_PARAM_BYTES = [0x00, 0x65];

/** Operating mode byte values (common across most modern Icom HF/VHF rigs). */
const MODE = {
  LSB: 0x00,
  USB: 0x01,
  AM: 0x02,
  CW: 0x03,
  RTTY: 0x04,
  FM: 0x05,
  WFM: 0x06,
  CW_R: 0x07,
  RTTY_R: 0x08,
  DV: 0x17,
};

const MODE_NAMES = Object.fromEntries(
  Object.entries(MODE).map(([name, value]) => [value, name])
);

/** Default controller (host) CI-V address. */
const DEFAULT_CONTROLLER_ADDR = 0xe0;

/**
 * Default CI-V addresses for common radios, as a convenience for initial
 * setup. Values can always be overridden, or discovered via
 * CivDriver#detectRadioAddress().
 */
const KNOWN_RADIO_ADDR = {
  'IC-7300': 0x94,
  'IC-7610': 0x98,
  'IC-9700': 0xa2,
  'IC-705': 0xa4,
  'IC-7100': 0x88,
  'IC-7850': 0x8e,
  'IC-7851': 0x8e,
};

module.exports = {
  CMD,
  SUBCMD,
  FUNCTION_SUBCMD,
  LEVEL_SUBCMD,
  SCOPE_SUBCMD,
  SCOPE_MODE,
  SCOPE_SPAN_PRESETS_HZ,
  OPTIONAL_SUBCMD,
  AF_OUTPUT_LEVEL_USB_PARAM_BYTES,
  MOD_INPUT_LEVEL_USB_PARAM_BYTES,
  MODE,
  MODE_NAMES,
  DEFAULT_CONTROLLER_ADDR,
  KNOWN_RADIO_ADDR,
  KEY_SPEED_TABLE,
  wpmToKeySpeed,
  keySpeedToWpm,
};
