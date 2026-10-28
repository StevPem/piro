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
 *     src/server/audio-bridge.js. Raw 16-bit PCM at state.audio.sampleRate.
 *   - AUDIO_OPUS / AUDIO_ADPCM: the same audio compressed, for remote use
 *     (see REQUEST.SET_AUDIO_CODEC and server/audio-codecs.js).
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
  FAX_LINE: 0x06, // server->client: one received radiofax line: [1..2] chart id UInt16LE, [3..4] line y, [5..6] width, [7..] one grey byte per pixel (0 black, 255 white). See server/fax-decoder-bridge.js
  // Compressed audio for remote use (see server/audio-codecs.js and
  // client/audio-codec.js). Both directions, mono. A browser chooses the
  // RX format with REQUEST.SET_AUDIO_CODEC; its mic audio may use either
  // tag, whatever it chose for RX.
  AUDIO_OPUS: 0x07, // [1..] one Opus packet (20 ms). RX is 16 kHz audio; TX any rate.
  AUDIO_ADPCM: 0x08, // [1..] one IMA ADPCM frame at 12 kHz: [1..2] first sample int16 LE, [3] step index, [4] 0, then 4 bits a sample, low nibble first
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
  GET_ALC: 'getAlc', // {} -> {value}: the ALC meter, raw 0 (minimum) to 120 (maximum), while transmitting (CI-V 15 13)
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
  SET_JTTY_ACTIVE: 'setJttyActive', // {active: boolean, txHz?: number} -> arms/disarms JTTY receive; txHz (200-2800) is the transmit audio frequency (lowest tone) shown in every browser (the client's TTY button is in JTTY); JTTY is an app-level mode layered on USB, so the radio's own mode can't say. Mirrors SET_FT8_ACTIVE; see server/jtty-decoder-bridge.js. Cleared automatically when the last client disconnects.
  SET_OLIVIA_ACTIVE: 'setOliviaActive', // {active: boolean, centreHz?: number} -> arms/disarms Olivia 8/250 receive (the client's TTY button is in Olivia) and sets the audio centre frequency it listens on (+/-125 Hz either side is searched); like JTTY, an app-level mode on USB. Sending it again with a new centreHz retunes. Cleared automatically when the last client disconnects. See server/olivia-decoder-bridge.js.
  SET_HELL_ACTIVE: 'setHellActive', // {active: boolean, toneHz?: number} -> arms/disarms Feld-Hell receive (the client's TTY button is in Feld-Hell) and sets the audio tone it paints; sending it again with a new toneHz retunes. Received picture columns go out as BINARY_TYPE.HELL_COLUMNS frames. Cleared automatically when the last client disconnects. See server/hell-decoder-bridge.js.
  SET_VARA_ACTIVE: 'setVaraActive', // {active: boolean} -> starts/stops the VARA chat modem (the client's TTY button is in VARA): Xara's VARA HF modem, in WebAssembly, on USB with DATA MODE on. It listens for calls and keys PTT itself while active. Cleared automatically when the last client disconnects (any QSO is dropped). See server/vara-bridge.js
  VARA: 'vara', // {action: 'cq'|'connect'|'disconnect'|'send'|'qsy', call?, text?, offsetHz?} -> drives the VARA chat modem: 'cq' sends a CQ frame, 'connect' calls `call`, 'disconnect' ends the QSO (or stops calling), 'qsy' asks the other station to move the QSO offsetHz up or down with VarAC's QSY handshake (it must have said it is ready, <Q> or <AWQ>), 'send' sends `text` as one VarAC message (its UTF-8 length, a space, the text; plain Latin-1 text ending in CR to a station that sends plain text). Fails if VARA isn't active or the request doesn't fit the state (e.g. 'send' with no QSO). See server/vara-bridge.js
  SET_SSTV_ACTIVE: 'setSstvActive', // {active: boolean} -> starts/stops the SSTV receiver (the client's SSTV mode button). Receive only. Pictures arrive as EVENT.SSTV_START, binary SSTV_LINE frames while they come in, and EVENT.SSTV_PICTURE (slant-corrected PNG) at the end. Cleared automatically when the last client disconnects. See server/sstv-decoder-bridge.js.
  END_SSTV_PICTURE: 'endSstvPicture', // {} -> ends the picture being received now (the Stop button), keeping what has arrived
  GET_SSTV_PICTURES: 'getSstvPictures', // {} -> {pictures: [...]}: the recent received pictures (EVENT.SSTV_PICTURE payloads, newest last), for a page that has just connected
  SEND_SSTV: 'sendSstv', // {rgb: base64, width, height} -> transmits the picture (RGB, 3 bytes per pixel, at the size given in the connect snapshot's sstvTx: the mode's width x lines * lineHeight) in the server's SSTV_TX_MODE, followed by the FSK ID and a CW ID; progress arrives as EVENT.SSTV_TX_STATUS. See server/sstv-tx-bridge.js.
  ABORT_SSTV: 'abortSstv', // {} -> stops an SSTV transmission
  SET_WSPR_ACTIVE: 'setWsprActive', // {active: boolean} -> WSPR on or off (the third choice of the client's DIGI button). WSPR is an app-level mode on USB + DATA MODE with 2-minute slots on even UTC minutes: every slot that isn't transmitting is decoded and the spots go out as EVENT.WSPR_DECODES (and to wsprnet.org unless WSPR_UPLOAD=off). While on, the TX power is held at 5 W or less; the power before is put back afterwards. Cleared automatically when the last client disconnects. See server/wspr-bridge.js
  SET_WSPR_TX: 'setWsprTx', // {enabled?: boolean, txHz?: number} -> whether WSPR transmits (about 1 slot in 5, as WSJT-X's "Tx Pct 20"), and the transmit audio frequency (1410-1590 Hz, default 1500; the signal is 6 Hz wide). Needs STATION_CALLSIGN (a plain call of up to 6 characters) and WSPR_GRID or STATION_GRID. The result is in EVENT.WSPR_STATUS
  GET_BAND_CONDITIONS: 'getBandConditions', // {} -> the "Current conditions" table: {grid, squares, myWindowMin, localWindowMin, localUpdatedMs, localError, myError, tags: [{tag, km}], bands: [{band, myQth: {tag, rangeKm?, stations?, slots?, lastMs?}, local: {tag, rangeKm?, stations?, reporters?}}]}. tag is Great/Good/Average/Bad/Dismal from the range (80th percentile of the distances of the stations heard), or N/A with no data. myQth is from PiRO's own WSPR decodes (last 90 min); local from wsprnet.org's spots of reporters in the site's square and the 8 around it (last 60 min, via wspr.live, kept 10 min). See server/band-conditions.js
  SET_AUDIO_CODEC: 'setAudioCodec', // {codec: 'pcm'|'opus'|'adpcm'} -> the format of the RX audio sent to this browser only: 'pcm' (the default, raw 16-bit PCM in AUDIO frames), 'opus' (AUDIO_OPUS frames, about 24 kbit/s) or 'adpcm' (AUDIO_ADPCM frames, 48 kbit/s). Not shared between browsers; forgotten when the browser disconnects. Refused if audio is off or the server can't compress (state.audio.codecs lists what it can). Replies {codec}
  SET_FAX_ACTIVE: 'setFaxActive', // {active: boolean} -> starts/stops the radiofax receiver (the client's Image button on Fax). Receive only, on USB. A chart starts on the start signal (or FAX_START_NOW) and its lines arrive as binary FAX_LINE frames, announced by EVENT.FAX_START and ended by EVENT.FAX_PICTURE. Cleared automatically when the last client disconnects. See server/fax-decoder-bridge.js
  FAX_START_NOW: 'faxStartNow', // {} -> starts a chart now, without waiting for the start signal (joining a broadcast part-way)
  FAX_STOP: 'faxStop', // {} -> ends the chart being received now, keeping what has arrived
  GET_FAX_PICTURES: 'getFaxPictures', // {} -> {pictures: [...]}: the recent received charts (EVENT.FAX_PICTURE payloads, newest last), and {current} the chart coming in, if any, with its lines so far as a PNG
  SET_EASYPAL_ACTIVE: 'setEasypalActive', // {active: boolean} -> starts/stops the EasyPal (HamDRM digital SSTV) receiver (the client's Image button on EasyPal), on USB. Sending is REQUEST.SEND_EASYPAL. The receiver's progress arrives as EVENT.EASYPAL_STATUS (and EVENT.EASYPAL_PREVIEW while a JPEG comes in); each received file as EVENT.EASYPAL_PICTURE. Cleared automatically when the last client disconnects. See server/easypal-decoder-bridge.js
  GET_EASYPAL_PICTURES: 'getEasypalPictures', // {} -> {pictures: [...], preview}: the recent received files (EVENT.EASYPAL_PICTURE payloads, newest last), and the last EVENT.EASYPAL_PREVIEW of a file still coming in, if any
  SEND_EASYPAL: 'sendEasypal', // {jpeg: base64} -> transmits the picture (a JPEG, at most 4 MB) as an EasyPal file with the server's EASYPAL_TX_* settings (summarised in the connect snapshot's easypalTx). The server shrinks it to fit 800 x 600 and lowers the JPEG quality, then the size, until it goes out within EASYPAL_TX_SECONDS. The radio must be on USB. Progress arrives as EVENT.EASYPAL_TX_STATUS; the sent picture is added to the EasyPal pictures (EVENT.EASYPAL_PICTURE with own: true). See server/easypal-tx-bridge.js
  ABORT_EASYPAL: 'abortEasypal', // {} -> stops an EasyPal transmission (or the preparation of one)
  POST_NOTE: 'postNote', // {text} -> adds a short note (at most 200 characters) to the operator notes shown under the PTT button in every browser; the 3 most recent are kept (ControlServer.state.notes, in the connect snapshot). Replies {notes}; the other browsers get EVENT.NOTES with `posted`, and chime and flash. Cleared after 60 minutes with no new note, or 2 minutes after the last browser disconnects.
  SEND_CW: 'sendCw', // {text, wpm?} -> sends the text as CW with the radio's own keyer (CI-V 17) at wpm (6-48, default 20), the CW mode's Send button. The radio must be in CW; semi break-in is turned on for it if it was off, and the key speed and break-in are put back afterwards. Progress arrives as EVENT.CW_TX_STATUS. See server/cw-tx-bridge.js
  ABORT_CW: 'abortCw', // {} -> stops CW text being sent (the radio drops what's left)
  ABORT_TTY: 'abortTty', // {} -> cuts a SEND_TTY transmission short (discards the queued audio and releases PTT); see audio/tty-bridge.js#abort
  SET_RTTY_REVERSED: 'setRttyReversed', // {reversed: boolean} -> the "Reverse" checkbox shown while RTTY is active; swaps which tone (mark/space) the decoder treats as which — see audio/rtty-decoder.js#setReversed and its constructor doc comment for why this is needed (RTTY polarity isn't predictable from the radio's mode alone). Defaults to false.
  SET_RNNOISE_LEVEL: 'setRnnoiseLevel', // {level: integer, 0..ControlServer.state.rnnoiseLevelCount-1} -> the "RNN" cycling button (replaces the old Noise Blanker button, and before that a plain on/off checkbox); arms/disarms an RNNoise speech-denoiser on the RX audio actually broadcast to clients — see server/audio-bridge.js#setRnnoiseLevel and audio/rnnoise-filter.js. Deliberately never touches the raw capture stream CW/RTTY/FT8/RADE decode from — see audio-bridge.js's own doc comment for why. level 0 ("RNN Off") disarms the filter entirely; every level above that ("RNN 1", "RNN 2", ...) arms it at a configured original/denoised blend ratio — the ratios (and so the total number of levels) come from the RNNOISE_WET env var, a comma-separated list, e.g. "0.25, 0.5, 0.75, 1.0" for the original 4-level 25/50/75/100% default — see RNNOISE_WET_LEVELS in server/index.js and _rnnoiseWetLevels in audio-bridge.js. Defaults to 0; requires the rnnoise_demo binary (RNNOISE_BIN) to be installed separately, and is a no-op (with a logged/broadcast AUDIO_ERROR, and the level reset to 0) if it isn't. Mutually exclusive with SET_HAMNOISE_ENABLED — setting a level above 0 here forces HamNoise off (see that request's own doc comment and audio-bridge.js's class doc comment for why).
  SET_VOICE_SQUELCH: 'setVoiceSquelch', // {enabled: boolean} -> the "Squelch" button beneath "HamNoise": a voice squelch on the RX audio sent to browsers (shared by all, like HamNoise), which passes speech and mutes the hiss between overs. Works only in a voice mode (LSB/USB/AM/FM, DATA mode off, no app mode); elsewhere it stands aside. Delays the audio by 0.3 s while working. Never touches the decoders' audio. See audio/voice-squelch.js and server/audio-bridge.js#setVoiceSquelch. Replies and broadcasts EVENT.VOICE_SQUELCH; the connect snapshot has `voiceSquelch`
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
  CONNECTED: 'connected', // sent once to a newly-connected client with a full state snapshot, plus clients: how many browsers are connected (this one included)
  CLIENTS: 'clients', // broadcast when a browser connects or disconnects: {count}, how many browsers are connected now. Shown in brackets after "Connected" at the top right
  RIG_ERROR: 'rig-error', // broadcast when the CI-V driver reports a hardware/serial error
  AUDIO_ERROR: 'audio-error', // broadcast when the audio pipeline (ALSA/Opus) hits an error
  SCOPE_ERROR: 'scope-error', // broadcast when the scope pipeline hits a decode error
  FT8_DECODES: 'ft8-decodes', // broadcast once per completed FT8 (15s) or FT4 (7.5s) slot, {slotStartMs, messages: DecodedFt8Message[]} — see ft8-bridge.js
  FT8_TX_STATUS: 'ft8-tx-status', // broadcast on FT8/FT4 TX lifecycle changes, {status: 'scheduled'|'sending'|'sent'|'error', message?, error?, sendAtMs?} — see ft8-bridge.js
  PSK_SPOT_ENABLED: 'psk-spot-enabled', // broadcast when the "PSK Spot" checkbox changes — see REQUEST.SET_PSK_SPOT_ENABLED / audio/psk-reporter.js
  FT8_VARIANT: 'ft8-variant', // broadcast when the active protocol (FT8 vs FT4) changes — see REQUEST.SET_FT8_VARIANT / ft8-bridge.js#setVariant
  FREEDV_VARIANT: 'freedv-variant', // broadcast when the active FreeDV variant (700E vs RADE) changes — see REQUEST.SET_FREEDV_VARIANT / rade-bridge.js#setVariant. Armed/idle state goes out in APP_MODES.
  APP_MODES: 'app-modes', // broadcast to the other clients whenever one of the app-level modes (layered on LSB/USB, so the radio can't report them) or its setting changes: {ft8Active, freeDvActive, jttyActive, jttyTxHz, oliviaActive, oliviaCentreHz, hellActive, hellToneHz, varaActive, sstvActive, wsprActive, faxActive, easypalActive}. Sent after SET_FT8_ACTIVE, SET_FREEDV_ACTIVE, SET_JTTY_ACTIVE, SET_OLIVIA_ACTIVE, SET_HELL_ACTIVE, SET_VARA_ACTIVE, SET_SSTV_ACTIVE, SET_WSPR_ACTIVE, SET_FAX_ACTIVE and SET_EASYPAL_ACTIVE, so every connected browser shows the same mode. See ControlServer#appModes.
  FREEDV_SPOT_ENABLED: 'freedv-spot-enabled', // broadcast when the "FreeDV spot" checkbox changes — see REQUEST.SET_FREEDV_SPOT_ENABLED / server/freedv-reporter.js
  FREEDV_MESSAGE: 'freedv-message', // broadcast when the FreeDV Reporter status message changes — see REQUEST.SET_FREEDV_MESSAGE / server/freedv-reporter.js
  JTTY_TEXT: 'jtty-text', // broadcast as a received JTTY message appears and grows, {id, freqHz, snr, text, status: 'growing'|'complete'|'expired', time, startTime} (time/startTime are epoch ms of the latest/first frame; the client updates its row for `id` in place) — see server/jtty-decoder-bridge.js and audio/jtty-rx.js
  OLIVIA_TEXT: 'olivia-text', // broadcast as Olivia characters are decoded, {text, snr, freqOffsetHz, centreHz, time}: text is the new characters only (a block of up to 3 at a time, every ~2 s), snr the receiver's S/N figure, freqOffsetHz how far the signal is from centreHz, time epoch ms — see server/olivia-decoder-bridge.js and audio/olivia-rx.js
  HELL_TEXT: 'hell-text', // broadcast as Feld-Hell text is read from the received picture (matched against the Feld-Hell font, a few seconds behind the picture), {text, time}: text is the new characters; with replace: true (sent to a page that has just connected) it is the recent text so far. See audio/hell-ocr.js and server/hell-decoder-bridge.js
  TTY_TX_STATUS: 'tty-tx-status', // broadcast on RTTY/JTTY/Olivia/Feld-Hell TX lifecycle changes, {status: 'sending'|'sent'|'aborted'|'error', mode, text?, message?, nframes?, durationSec?, error?} — see audio/tty-bridge.js
  SSTV_START: 'sstv-start', // broadcast when an SSTV picture starts, {id, mode, name, width, lines, lineHeight, shiftHz, time}: mode is the VIS-detected mode id (e.g. 'M1', 'PD120'), shiftHz how far the signal is from the standard tones; its lines follow as binary SSTV_LINE frames
  SSTV_FSK_ID: 'sstv-fsk-id', // broadcast when the FSK ID after a received picture is read, {id, text}: the sender's callsign; also stored as the picture's fskId
  SSTV_TX_STATUS: 'sstv-tx-status', // broadcast on SSTV transmit progress, {status: 'encoding'|'sending'|'sent'|'aborted'|'error', mode, name, durationSec?, startTime?, elapsedSec?, timeline?, lines?, png?, error?}. With 'sending': elapsedSec is how far in it is (0 when broadcast; a page that connects during a transmission is sent the current status with its own elapsedSec), timeline {headerSec, pictureSec, fskSec, gapSec, cwSec, totalSec} the parts in order, lines the picture's line count and png the picture going out (base64). See server/sstv-tx-bridge.js
  SSTV_PICTURE: 'sstv-picture', // broadcast when an SSTV picture ends, {id, mode, name, width, lines, lineHeight, shiftHz, time, endTime, complete, linesReceived, slantDeg, png}: png is the slant-corrected picture as base64 PNG; complete is false if it was cut short
  RTTY_REVERSED: 'rtty-reversed', // broadcast when the RTTY "Reverse" checkbox changes — see REQUEST.SET_RTTY_REVERSED / audio/rtty-decoder-bridge.js
  RNNOISE_LEVEL: 'rnnoise-level', // broadcast when the "RNN" button's level changes — see REQUEST.SET_RNNOISE_LEVEL / server/audio-bridge.js. Also broadcast with level 0 when AudioBridge forces RNNoise off because HamNoise was just enabled (mutual exclusion — see REQUEST.SET_HAMNOISE_ENABLED).
  VOICE_SQUELCH: 'voice-squelch', // {enabled, active} broadcast to every browser when the voice squelch is switched, or starts or stops working because the mode changed (active: enabled and in a voice mode). See REQUEST.SET_VOICE_SQUELCH
  HAMNOISE_ENABLED: 'hamnoise-enabled', // broadcast when the "HamNoise" button's state changes — see REQUEST.SET_HAMNOISE_ENABLED / server/audio-bridge.js. Also broadcast with enabled:false when AudioBridge forces HamNoise off because RNN was just set to a level above 0 (mutual exclusion), or after a load/processing failure (see audio-bridge.js#_handleHamNoiseError).
  CW_TX_STATUS: 'cw-tx-status', // broadcast on CW text sending, {status: 'sending'|'sent'|'aborted'|'error', text?, wpm?, durationSec?, startTime?, dropped?, error?}: text as sent (capitals, unsendable characters left out and listed in dropped) — see server/cw-tx-bridge.js
  NOTES: 'notes', // broadcast when the operator notes change: {notes: [{id, text, time}] (newest last), posted?: the note just added (browsers chime and flash), cleared?: 'idle'|'empty'} — see REQUEST.POST_NOTE
  WSPR_STATUS: 'wspr-status', // broadcast when WSPR's state changes (also ControlServer.state.wspr in the connect snapshot): {phase: 'idle'|'rx'|'tx', slotStartMs, slotEndMs, txEnabled, txHz, txPct, canTransmit, txMessage, txReason?, nextTx?, upload, uploadStatus?, unattended, unattendedBand, bandCycle, cycleBands, bandMinutes, tuning, decoding, lastSlotStartMs?, lastDecodeCount?}. txMessage is what is sent (callsign, 4-character grid, dBm from the radio's power); unattended is true while receiving with nobody connected (WSPR_UNATTENDED), unattendedBand the band it is on ('20m'), bandCycle whether that run changes band (WSPR_BAND_CYCLE), cycleBands the bands it goes through (all but WSPR_SKIP_BANDS), bandMinutes the time on each (WSPR_BAND_MINUTES), and tuning true while the antenna tuner runs after a band change. See server/wspr-bridge.js
  WSPR_DECODES: 'wspr-decodes', // broadcast after each WSPR slot is decoded, {slotStartMs, dialHz, decodes: [{snr, dt, audioHz, drift, message, callsign, grid, dbm, type}]}; with replace: true (sent to a page that has just connected) `decodes` is the recent list from every slot, each with its own slotStartMs and dialHz
  FAX_STATUS: 'fax-status', // broadcast when the radiofax receiver's state changes: {state: 'idle'|'listening'|'phasing'|'receiving', lines, clockPpm}. Also ControlServer.state.fax in the connect snapshot
  FAX_START: 'fax-start', // broadcast when a radiofax chart starts, {id, width, lpm, ioc, phased, clockPpm, time}: phased is false for a chart started by hand (line start unknown); its lines follow as binary FAX_LINE frames
  FAX_PICTURE: 'fax-picture', // broadcast when a radiofax chart ends, {id, width, lines, time, endTime, complete, reason, clockPpm, png}: png is the chart as a base64 greyscale PNG
  EASYPAL_STATUS: 'easypal-status', // broadcast as the EasyPal receiver works (about every 0.4 s while it hears a signal): {state: 'idle'|'listening'|'sync'|'receiving', snr, mode: {mode:'A'|'B'|'E', bandwidth: 2.3|2.5, qam: 4|16|64, protection, interleave}|null, callsign, offsetHz, file: {transportId, fileName, received, total, totalKnown}|null}: offsetHz is how far the signal is from where EasyPal puts it (its centre at 350 Hz), i.e. the mistuning; total is the segments seen so far until the last one has arrived (totalKnown). Also ControlServer.state.easypal in the connect snapshot
  EASYPAL_PREVIEW: 'easypal-preview', // broadcast every few seconds while a plain JPEG comes in: {transportId, fileName, mime, data}: data is base64, the segments received so far in order (the top of the picture)
  EASYPAL_PICTURE: 'easypal-picture', // broadcast when a file has been received, {id, transportId, time, fileName, callsign, mode, snr, segments, recovered, size, mime, data, width, height, text}: data (base64) is what to show (JPEG as sent; JPEG 2000 decoded and sent as a JPEG, at most 1600 pixels across; width and height are of what is sent); text for a text file; recovered is how many missing segments Reed-Solomon put back; own is true (and transportId null) for a picture this station sent
  EASYPAL_TX_STATUS: 'easypal-tx-status', // broadcast on EasyPal transmit progress, {status: 'preparing'|'sending'|'sent'|'aborted'|'error', durationSec?, startTime?, elapsedSec?, fileName?, bytes?, width?, height?, quality?, jpeg?, error?}. 'preparing' while the picture is fitted and the audio made (a few seconds on a Pi). With 'sending': elapsedSec is how far in it is (0 when broadcast; a page that connects during a transmission is sent the current status with its own elapsedSec), jpeg the picture going out (base64), bytes the file size with its Reed-Solomon protection. See server/easypal-tx-bridge.js
  VARA_STATUS: 'vara-status', // broadcast when the VARA chat modem's state changes (also ControlServer.state.vara in the connect snapshot): {available, reason, callsign, bw, state: 'off'|'starting'|'listening'|'calling'|'connected'|'disconnecting', peer, linkBw, pending, busy, ptt, sn, bitrate, buffer, qsyReady, qsy: {role, target, phase}|null (qsyReady: the other station has said it is ready to QSY; qsy: VarAC's QSY handshake under way, phase 'sending'|'ack'|'tl'|'qsyr'|'opening'), heard: [{call, raw, slot, offsetHz, beacon, grid?, services?, bw, sn, time}]}. available is false (reason says why) without STATION_CALLSIGN or 48 kHz audio; pending is an incoming call being set up; busy that the channel is in use; sn the link's S/N (dB), bitrate its speed (bps), buffer the bytes still to send; heard the CQ frames and VarAC beacons heard (a beacon from its KISS broadcast has grid and services), newest first, with their S/N; a VarAC CQ's callsign suffix is its slot (call is the callsign without it, offsetHz the slot's distance from the calling frequency; -9 is a beacon), see server/varac.js; (null if none was reported). With PSK Spot on (REQUEST.SET_PSK_SPOT_ENABLED), CQs heard and the station connected to are also spotted to pskreporter.info. See server/vara-bridge.js
  VARA_TEXT: 'vara-text', // broadcast as the VARA conversation grows, {text, own, note, time}: received text (VarAC tags put into words), own text sent (own: true), or a line from PiRO about the link (note: true, e.g. "Connected to VK3ABC (500 Hz)"). A page that connects is sent {replace: true, segments: [{text, own?, note?}]}, the conversation so far
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
