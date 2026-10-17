'use strict';

/**
 * Message protocol for the control WebSocket. Plain JSON, request/response
 * correlated by `id` for client-initiated requests, plus unsolicited
 * server->client events (no `id`) for state changes and broadcasts.
 *
 * Client -> server request:
 *   { id: "1", type: "setFrequency", value: 14195000 }
 *
 * Server -> client result (reply to a request):
 *   { id: "1", type: "result", ok: true, data: { value: 14195000 } }
 *
 * Server -> client error (reply to a request):
 *   { id: "1", type: "error", ok: false, error: "message" }
 *
 * Server -> client event (unsolicited, no id):
 *   { type: "frequency", data: { value: 14195000 } }
 *
 * Binary WebSocket frames (not JSON) carry audio and scope data,
 * multiplexed on the same connection via a 1-byte type tag as the first
 * byte of every binary frame (see BINARY_TYPE below):
 *   - AUDIO: server->client = one chunk of the radio's RX audio;
 *     client->server = one chunk of the operator's mic audio (TX). See
 *     src/server/audio-bridge.js.
 *   - SCOPE_LINE: server->client only, one reassembled spectrum scope
 *     line. See src/server/scope-bridge.js. The client-side decoder
 *     mirrors this format in src/client/rpc.js — keep both in sync if
 *     this changes.
 *   - FT8_SPECTRUM: server->client only, one audio-domain FFT magnitude
 *     frame for the FT8 spectrum/waterfall display (an actual FFT of the
 *     RX audio, not a crop of the RF scope — see src/audio/ft8-bridge.js
 *     and docs/ui-notes.md). The client-side decoder mirrors this format
 *     in src/client/rpc.js — keep both in sync if this changes.
 *   - HELL_COLUMNS: server->client only, received Feld-Hell picture
 *     columns (see src/server/hell-decoder-bridge.js): byte 1 = rows per
 *     column, byte 2 = column count, bytes 3-4 = the receive tone in Hz
 *     (uint16 LE), then `count` columns of `rows` ink bytes (0-255), each
 *     column bottom pixel first. Mirrored in src/client/rpc.js.
 *   - SSTV_LINE: server->client only, one received SSTV picture line as it
 *     arrives (see src/server/sstv-decoder-bridge.js): bytes 1-2 = picture
 *     id, bytes 3-4 = line number, bytes 5-6 = width (all uint16 LE), then
 *     width * 3 bytes of RGB. Mirrored in src/client/rpc.js.
 */

const BINARY_TYPE = {
  AUDIO: 0x01,
  SCOPE_LINE: 0x02,
  FT8_SPECTRUM: 0x03,
  HELL_COLUMNS: 0x04,
  SSTV_LINE: 0x05,
};

const REQUEST = {
  GET_FREQUENCY: 'getFrequency',
  SET_FREQUENCY: 'setFrequency',
  GET_MODE: 'getMode',
  SET_MODE: 'setMode',
  SET_DATA_MODE: 'setDataMode', // {on: boolean} -> IC-7300 "DATA MODE" (distinct from the operating mode itself); see civ/driver.js#setDataMode
  GET_DATA_MODE: 'getDataMode',
  SET_PTT: 'setPtt',
  GET_SMETER: 'getSMeter',
  SET_SCOPE_BAND: 'setScopeBand', // {lowHz, highHz} -> tunes the scope to show that range; see ws-server.js
  SET_SCOPE_SPAN: 'setScopeSpan', // {spanHz} -> Center mode + this span (clamped to nearest preset); see ws-server.js
  SET_PREAMP: 'setPreamp', // {value: 0|1|2} -> 0=OFF, 1=Amp 1, 2=Amp 2
  SET_NOISE_REDUCTION: 'setNoiseReduction', // {on: boolean}
  SET_NOISE_BLANKER: 'setNoiseBlanker', // {on: boolean}
  SET_NOTCH: 'setNotch', // {on: boolean} -> auto notch, see FUNCTION_SUBCMD in src/civ/commands.js
  SET_TUNER: 'setTuner', // {value: 0|1|2} -> 0=OFF, 1=ON, 2=start tuning now
  GET_PREAMP: 'getPreamp',
  GET_NOISE_REDUCTION: 'getNoiseReduction',
  GET_NOISE_BLANKER: 'getNoiseBlanker',
  GET_NOTCH: 'getNotch',
  GET_TUNER: 'getTuner',
  GET_SWR: 'getSWR',
  SET_FILTER: 'setFilter', // {value: 1|2|3}
  GET_FILTER: 'getFilter',
  SET_TX_POWER: 'setTxPower', // {watts: number}
  GET_TX_POWER: 'getTxPower',
  SET_RX_GAIN: 'setRxGain', // {value: 0-255}
  GET_RX_GAIN: 'getRxGain',
  SET_FT8_ACTIVE: 'setFt8Active', // {active: boolean} -> arms/disarms FT8 RX decoding; see ft8-bridge.js
  SEND_FT8: 'sendFt8', // {message: string, freqHz?: number} -> encodes and transmits at the next FT8 slot boundary; freqHz optionally targets a specific audio frequency (see ft8-qso.js), otherwise Ft8Bridge's own default is used; see ft8-bridge.js
  SET_PSK_SPOT_ENABLED: 'setPskSpotEnabled', // {enabled: boolean} -> the "PSK Spot" checkbox; toggles reporting decoded FT8 stations to pskreporter.info, see audio/psk-reporter.js
  SET_FT8_VARIANT: 'setFt8Variant', // {variant: 'FT8'|'FT4'} -> switches the FT8 mode button's protocol (and slot timing); see ft8-bridge.js#setVariant
  SET_FREEDV_ACTIVE: 'setFreeDvActive', // {active: boolean} -> arms/disarms the FreeDV codec bridge (mirrors SET_FT8_ACTIVE); see rade-bridge.js. Only has any real effect while the active variant is 'RADE' — see SET_FREEDV_VARIANT below and rade-bridge.js's own doc comment for why '700E' stays a no-op.
  SET_FREEDV_VARIANT: 'setFreeDvVariant', // {variant: '700E'|'RADE'} -> switches the FreeDV mode button's variant (mirrors SET_FT8_VARIANT); see rade-bridge.js#setVariant
  SET_FREEDV_SPOT_ENABLED: 'setFreeDvSpotEnabled', // {enabled: boolean} -> the "FreeDV spot" checkbox; toggles reporting this station to qso.freedv.org while FreeDV is armed, see server/freedv-reporter.js. Unlike SET_PSK_SPOT_ENABLED, defaults to false (opt-in, not opt-out) per the original request.
  SET_FREEDV_MESSAGE: 'setFreeDvMessage', // {message: string} -> freeform status text relayed as FreeDV Reporter's message_update; empty string clears it. Persistent (cached in ControlServer.state.freeDvMessage and broadcast) — a standing status, not a one-off spot.
  SEND_TTY: 'sendTty', // {mode: 'RTTY'|'JTTY'|'OLIVIA'|'HELL', text: string, freqHz?: number} -> encodes the text and transmits it immediately (none of these modes is slotted, unlike FT8): RTTY as 45.45-baud Baudot AFSK, JTTY as WSJT-X's 4-GFSK mode, OLIVIA as Olivia 8/250 MFSK, HELL as Feld-Hell (an on-off keyed tone drawing the text); freqHz is the JTTY lowest-tone, the Olivia centre or the Feld-Hell tone audio frequency (ignored for RTTY, whose tones are fixed). The outcome arrives as EVENT.TTY_TX_STATUS broadcasts; see audio/tty-bridge.js, audio/rtty-encoder.js and audio/jtty-tx.js.
  SET_JTTY_ACTIVE: 'setJttyActive', // {active: boolean} -> arms/disarms JTTY receive (the client's TTY button is in JTTY); JTTY is an app-level mode layered on USB, so the radio's own mode can't say. Mirrors SET_FT8_ACTIVE; see server/jtty-decoder-bridge.js. Cleared automatically when the last client disconnects.
  SET_OLIVIA_ACTIVE: 'setOliviaActive', // {active: boolean, centreHz?: number} -> arms/disarms Olivia 8/250 receive (the client's TTY button is in Olivia) and sets the audio centre frequency it listens on (+/-125 Hz either side is searched); like JTTY, an app-level mode on USB. Sending it again with a new centreHz retunes. Cleared automatically when the last client disconnects. See server/olivia-decoder-bridge.js.
  SET_HELL_ACTIVE: 'setHellActive', // {active: boolean, toneHz?: number} -> arms/disarms Feld-Hell receive (the client's TTY button is in Feld-Hell) and sets the audio tone it paints; sending it again with a new toneHz retunes. Received picture columns go out as BINARY_TYPE.HELL_COLUMNS frames. Cleared automatically when the last client disconnects. See server/hell-decoder-bridge.js.
  SET_SSTV_ACTIVE: 'setSstvActive', // {active: boolean} -> starts/stops the SSTV receiver (the client's SSTV mode button). Receive only. Pictures arrive as EVENT.SSTV_START, binary SSTV_LINE frames while they come in, and EVENT.SSTV_PICTURE (slant-corrected PNG) at the end. Cleared automatically when the last client disconnects. See server/sstv-decoder-bridge.js.
  END_SSTV_PICTURE: 'endSstvPicture', // {} -> ends the picture being received now (the Stop button), keeping what has arrived
  GET_SSTV_PICTURES: 'getSstvPictures', // {} -> {pictures: [...]}: the recent received pictures (EVENT.SSTV_PICTURE payloads, newest last), for a page that has just connected
  SEND_SSTV: 'sendSstv', // {rgb: base64, width, height} -> transmits the picture (RGB, 3 bytes per pixel, at the size given in the connect snapshot's sstvTx: the mode's width x lines * lineHeight) in the server's SSTV_TX_MODE, followed by the FSK ID and a CW ID; progress arrives as EVENT.SSTV_TX_STATUS. See server/sstv-tx-bridge.js.
  ABORT_SSTV: 'abortSstv', // {} -> stops an SSTV transmission
  ABORT_TTY: 'abortTty', // {} -> cuts a SEND_TTY transmission short (discards the queued audio and releases PTT); see audio/tty-bridge.js#abort
  SET_RTTY_REVERSED: 'setRttyReversed', // {reversed: boolean} -> the "Reverse" checkbox shown while RTTY is active; swaps which tone (mark/space) the decoder treats as which — see audio/rtty-decoder.js#setReversed and its constructor doc comment for why this is needed (RTTY polarity isn't predictable from the radio's mode alone). Defaults to false.
  SET_RNNOISE_LEVEL: 'setRnnoiseLevel', // {level: integer, 0..ControlServer.state.rnnoiseLevelCount-1} -> the "RNN" cycling button (replaces the old Noise Blanker button, and before that a plain on/off checkbox); arms/disarms an RNNoise speech-denoiser on the RX audio actually broadcast to clients — see server/audio-bridge.js#setRnnoiseLevel and audio/rnnoise-filter.js. Deliberately never touches the raw capture stream CW/RTTY/FT8/RADE decode from — see audio-bridge.js's own doc comment for why. level 0 ("RNN Off") disarms the filter entirely; every level above that ("RNN 1", "RNN 2", ...) arms it at a configured original/denoised blend ratio — the ratios (and so the total number of levels) come from the RNNOISE_WET env var, a comma-separated list, e.g. "0.25, 0.5, 0.75, 1.0" for the original 4-level 25/50/75/100% default — see RNNOISE_WET_LEVELS in server/index.js and _rnnoiseWetLevels in audio-bridge.js. Defaults to 0; requires the rnnoise_demo binary (RNNOISE_BIN) to be installed separately, and is a no-op (with a logged/broadcast AUDIO_ERROR, and the level reset to 0) if it isn't. Mutually exclusive with SET_HAMNOISE_ENABLED — setting a level above 0 here forces HamNoise off (see that request's own doc comment and audio-bridge.js's class doc comment for why).
  SET_HAMNOISE_ENABLED: 'setHamnoiseEnabled', // {enabled: boolean} -> the "HamNoise" button beneath "RNN"; arms/disarms HamNoise (https://github.com/e04/HamNoise, AGPL-3.0, see models/hamnoise/NOTICE.md), a second neural RX denoiser, on exactly the same RX audio path RNNoise occupies (never the raw capture stream CW/RTTY/FT8/RADE decode from, for the identical reason) — see server/audio-bridge.js#setHamNoiseEnabled and audio/hamnoise-filter.js. A plain on/off toggle, not a leveled cycle like RNN — HamNoise has no wet-ratio knob to expose. Mutually exclusive with SET_RNNOISE_LEVEL (enabling either one forces the other off; both broadcast the resulting forced-off state so every client's button stays in sync — see audio-bridge.js's class doc comment), but freely usable alongside the radio's own internal noise reduction (the NR button) — that's a separate hardware/CI-V stage this app has no involvement in. Automatically picks HamNoise's CW-trained or voice-trained model based on the radio's current operating mode (tracked via CivDriver's own 'mode' event — see audio-bridge.js#_handleCivModeChange), with no separate client-facing control for that choice. Defaults to false; requires the bundled models/hamnoise/*.wasm files, which ship with this project (no separate binary install, unlike RNNoise) — a load failure is a no-op (with a logged/broadcast AUDIO_ERROR, and the toggle reset to false).
  SET_CW_DECODER_VARIANT: 'setCwDecoderVariant', // {variant: 'CW1'|'CW2'|'CW3'} -> switches which CW decoding algorithm the CW mode chip's ticker uses: 'CW1' (audio/cw-decoder.js, this app's original single-frequency Goertzel decoder), 'CW2' (audio/hamfist-cw-decoder.js, a port of Jonathan Dawson's FFT/multi-channel/beam-search "Hamfist" decoder, https://github.com/dawsonjon/HamFist), or 'CW3' (audio/deepcw-decoder.js, a neural-network/CTC decoder ported from e04/deepcw-engine — batches fixed-length audio windows through an ONNX model rather than decoding live character-by-character; see that file's doc comment). See cw-decoder-bridge.js and the CW mode chip's click handler in app.js (a click while CW mode is already active cycles CW1 -> CW2 -> CW3 -> CW1, the same "second click repurposed" pattern as the FT8 chip's protocol toggle).
};

const EVENT = {
  FREQUENCY: 'frequency',
  MODE: 'mode',
  DATA_MODE: 'data-mode', // broadcast on IC-7300 DATA MODE changes — see REQUEST.SET_DATA_MODE / civ/driver.js#setDataMode
  PTT: 'ptt',
  PTT_TIMEOUT: 'ptt-timeout', // broadcast when the PTT watchdog force-releases TX — see ws-server.js
  CW_TEXT: 'cw-text', // broadcast per decoded CW character/word-space — see cw-decoder-bridge.js
  RTTY_TEXT: 'rtty-text', // broadcast per decoded RTTY (Baudot/ITA2) character — see rtty-decoder-bridge.js
  CONNECTED: 'connected', // sent once to a newly-connected client with a full state snapshot
  RIG_ERROR: 'rig-error', // broadcast when the CI-V driver reports a hardware/serial error
  AUDIO_ERROR: 'audio-error', // broadcast when the audio pipeline (ALSA/Opus) hits an error
  SCOPE_ERROR: 'scope-error', // broadcast when the scope pipeline hits a decode error
  FT8_DECODES: 'ft8-decodes', // broadcast once per completed FT8 (15s) or FT4 (7.5s) slot, {slotStartMs, messages: DecodedFt8Message[]} — see ft8-bridge.js
  FT8_TX_STATUS: 'ft8-tx-status', // broadcast on FT8/FT4 TX lifecycle changes, {status: 'scheduled'|'sending'|'sent'|'error', message?, error?, sendAtMs?} — see ft8-bridge.js
  PSK_SPOT_ENABLED: 'psk-spot-enabled', // broadcast when the "PSK Spot" checkbox changes — see REQUEST.SET_PSK_SPOT_ENABLED / audio/psk-reporter.js
  FT8_VARIANT: 'ft8-variant', // broadcast when the active protocol (FT8 vs FT4) changes — see REQUEST.SET_FT8_VARIANT / ft8-bridge.js#setVariant
  FREEDV_VARIANT: 'freedv-variant', // broadcast when the active FreeDV variant (700E vs RADE) changes — see REQUEST.SET_FREEDV_VARIANT / rade-bridge.js#setVariant. Unlike FT8_VARIANT there's no FREEDV_ACTIVE equivalent broadcast — armed/idle state isn't synced across clients, the same deliberate simplification FT8's own SET_FT8_ACTIVE already has (see ws-server.js).
  FREEDV_SPOT_ENABLED: 'freedv-spot-enabled', // broadcast when the "FreeDV spot" checkbox changes — see REQUEST.SET_FREEDV_SPOT_ENABLED / server/freedv-reporter.js
  FREEDV_MESSAGE: 'freedv-message', // broadcast when the FreeDV Reporter status message changes — see REQUEST.SET_FREEDV_MESSAGE / server/freedv-reporter.js
  JTTY_TEXT: 'jtty-text', // broadcast as a received JTTY message appears and grows, {id, freqHz, snr, text, status: 'growing'|'complete'|'expired', time, startTime} (time/startTime are epoch ms of the latest/first frame; the client updates its row for `id` in place) — see server/jtty-decoder-bridge.js and audio/jtty-rx.js
  OLIVIA_TEXT: 'olivia-text', // broadcast as Olivia characters are decoded, {text, snr, freqOffsetHz, centreHz, time}: text is the new characters only (a block of up to 3 at a time, every ~2 s), snr the receiver's S/N figure, freqOffsetHz how far the signal is from centreHz, time epoch ms — see server/olivia-decoder-bridge.js and audio/olivia-rx.js
  TTY_TX_STATUS: 'tty-tx-status', // broadcast on RTTY/JTTY/Olivia/Feld-Hell TX lifecycle changes, {status: 'sending'|'sent'|'aborted'|'error', mode, text?, message?, nframes?, durationSec?, error?} — see audio/tty-bridge.js
  SSTV_START: 'sstv-start', // broadcast when an SSTV picture starts, {id, mode, name, width, lines, lineHeight, shiftHz, time}: mode is the VIS-detected mode id (e.g. 'M1', 'PD120'), shiftHz how far the signal is from the standard tones; its lines follow as binary SSTV_LINE frames
  SSTV_FSK_ID: 'sstv-fsk-id', // broadcast when the FSK ID after a received picture is read, {id, text}: the sender's callsign; also stored as the picture's fskId
  SSTV_TX_STATUS: 'sstv-tx-status', // broadcast on SSTV transmit progress, {status: 'encoding'|'sending'|'sent'|'aborted'|'error', mode, name, durationSec?, startTime?, error?} — see server/sstv-tx-bridge.js
  SSTV_PICTURE: 'sstv-picture', // broadcast when an SSTV picture ends, {id, mode, name, width, lines, lineHeight, shiftHz, time, endTime, complete, linesReceived, slantDeg, png}: png is the slant-corrected picture as base64 PNG; complete is false if it was cut short
  RTTY_REVERSED: 'rtty-reversed', // broadcast when the RTTY "Reverse" checkbox changes — see REQUEST.SET_RTTY_REVERSED / audio/rtty-decoder-bridge.js
  RNNOISE_LEVEL: 'rnnoise-level', // broadcast when the "RNN" button's level changes — see REQUEST.SET_RNNOISE_LEVEL / server/audio-bridge.js. Also broadcast with level 0 when AudioBridge forces RNNoise off because HamNoise was just enabled (mutual exclusion — see REQUEST.SET_HAMNOISE_ENABLED).
  HAMNOISE_ENABLED: 'hamnoise-enabled', // broadcast when the "HamNoise" button's state changes — see REQUEST.SET_HAMNOISE_ENABLED / server/audio-bridge.js. Also broadcast with enabled:false when AudioBridge forces HamNoise off because RNN was just set to a level above 0 (mutual exclusion), or after a load/processing failure (see audio-bridge.js#_handleHamNoiseError).
  CW_DECODER_VARIANT: 'cw-decoder-variant', // broadcast when the CW mode chip's decoder algorithm (CW1/CW2/CW3) changes — see REQUEST.SET_CW_DECODER_VARIANT / server/cw-decoder-bridge.js
};

function makeResult(id, data) {
  return JSON.stringify({ id, type: 'result', ok: true, data });
}

function makeError(id, message) {
  return JSON.stringify({ id, type: 'error', ok: false, error: message });
}

function makeEvent(type, data) {
  return JSON.stringify({ type, data });
}

module.exports = { REQUEST, EVENT, BINARY_TYPE, makeResult, makeError, makeEvent };
