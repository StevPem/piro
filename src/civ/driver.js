'use strict';

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const { FrameParser, encodeFrame, freqToBCD, bcdToFreq } = require('./frame');
const { ScopeLineAssembler } = require('./scope');
const {
  CMD,
  SUBCMD,
  FUNCTION_SUBCMD,
  LEVEL_SUBCMD,
  SCOPE_SUBCMD,
  SCOPE_MODE,
  SCOPE_SPAN_PRESETS_HZ,
  OPTIONAL_SUBCMD,
  DATA_MODE_PARAM_BYTES,
  AF_OUTPUT_LEVEL_USB_PARAM_BYTES,
  MOD_INPUT_LEVEL_USB_PARAM_BYTES,
  MODE,
  MODE_NAMES,
  DEFAULT_CONTROLLER_ADDR,
} = require('./commands');

const BROADCAST_ADDR = 0x00;

/**
 * Driver for talking to an Icom transceiver over CI-V via a USB serial
 * connection. Handles framing, echo suppression, and a simple
 * request/response queue on top of the half-duplex CI-V bus, and emits
 * events for unsolicited ("transceive") updates the radio pushes when the
 * operator changes something from the front panel.
 *
 * Events:
 *   'open'                          - serial port opened
 *   'close'                         - serial port closed
 *   'error', (err)                  - serial port or parsing error
 *   'frequency', (hz)               - frequency changed (unsolicited)
 *   'mode', ({mode, filter})        - mode changed — fired for a genuine
 *                                      unsolicited transceive notification
 *                                      from the radio, AND synthesized
 *                                      locally by setMode()/setFilter() the
 *                                      instant they succeed (see setMode()'s
 *                                      own doc comment for why the latter
 *                                      is load-bearing, not just a nicety)
 *   'scope-line', (line)            - a fully reassembled scope waveform line
 *                                      (see src/civ/scope.js); only fires once
 *                                      enableScopeOutput() has been called and
 *                                      the radio actually supports/cooperates —
 *                                      see docs/civ-notes.md
 *   'unknown-frame', (frame)        - any frame not otherwise handled
 */
class CivDriver extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.path - serial device path, e.g. '/dev/ttyUSB0'
   * @param {number} [opts.baudRate=19200]
   * @param {number} [opts.controllerAddr=0xE0] - our (host) CI-V address
   * @param {number} [opts.radioAddr] - radio's CI-V address, if known
   * @param {number} [opts.requestTimeoutMs=1000]
   * @param {object} [opts.transport] - inject a fake serial-port-like object
   *   (must support write(buf, cb), on(event, cb), isOpen, close(cb)) instead
   *   of opening a real SerialPort — used by tests, not needed for real use.
   */
  constructor(opts) {
    super();
    if (!opts || !opts.path) {
      throw new Error('CivDriver requires opts.path (serial device path)');
    }
    this.path = opts.path;
    this.baudRate = opts.baudRate ?? 19200;
    this.controllerAddr = opts.controllerAddr ?? DEFAULT_CONTROLLER_ADDR;
    this.radioAddr = opts.radioAddr ?? null;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 1000;
    this._transport = opts.transport ?? null;

    this.port = null;
    this._parser = new FrameParser();
    this._queue = [];
    this._current = null;

    this._scope = new ScopeLineAssembler();
    this._scope.on('line', (line) => this.emit('scope-line', line));
    this._scope.on('error', (err) => this.emit('error', err));
  }

  /** Open the serial connection. Resolves once the port is open. */
  open() {
    return new Promise((resolve, reject) => {
      if (this._transport) {
        this.port = this._transport;
        this._wirePortEvents();
        this.emit('open');
        resolve();
        return;
      }
      this.port = new SerialPort(
        { path: this.path, baudRate: this.baudRate },
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          this.emit('open');
          resolve();
        }
      );
      this._wirePortEvents();
    });
  }

  _wirePortEvents() {
    this.port.on('data', (chunk) => this._handleData(chunk));
    this.port.on('error', (err) => this.emit('error', err));
    this.port.on('close', () => this.emit('close'));
  }

  /** Close the serial connection. */
  close() {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen) {
        resolve();
        return;
      }
      this.port.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ---- low-level frame I/O -----------------------------------------

  _handleData(chunk) {
    let frames;
    try {
      frames = this._parser.push(chunk);
    } catch (err) {
      this.emit('error', err);
      return;
    }
    for (const frame of frames) this._handleFrame(frame);
  }

  _handleFrame(frame) {
    // Frames "from" our own controller address are the bus echoing back
    // what we just wrote (common on USB CI-V links). They carry no new
    // information, so discard them unconditionally.
    if (frame.from === this.controllerAddr) return;

    if (this._current && this._frameMatchesCurrent(frame)) {
      clearTimeout(this._current.timer);
      const job = this._current;
      this._current = null;
      job.resolve(frame);
      this._dequeueNext();
      return;
    }

    this._emitUnsolicited(frame);
  }

  _frameMatchesCurrent(frame) {
    const job = this._current;
    if (!job) return false;
    // OK/NG replies confirm a "set" command completed.
    if (frame.cmd === CMD.OK || frame.cmd === CMD.NG) return true;
    if (frame.cmd !== job.cmd) return false;
    // Some commands (e.g. 0x27 scope, 0x1A sub-families) share one cmd
    // byte across several distinct sub-commands, including ones that push
    // unsolicited data continuously (scope waveform lines). Without also
    // checking subCmd, a fast-arriving unsolicited frame with the same
    // cmd byte could be mistaken for the reply to an unrelated pending
    // request. Only enforced when the request actually specified a
    // subCmd — plain cmd-only requests (e.g. SEND_FREQ) still match on
    // cmd alone, same as before.
    if (job.subCmd !== undefined && job.subCmd !== null) {
      return frame.subCmd === job.subCmd;
    }
    return true;
  }

  _emitUnsolicited(frame) {
    switch (frame.cmd) {
      case CMD.TRANSCEIVE_FREQ: {
        try {
          this.emit('frequency', bcdToFreq(frame.payload));
        } catch (err) {
          this.emit('error', err);
        }
        return;
      }
      case CMD.TRANSCEIVE_MODE: {
        const modeByte = frame.payload[0];
        const filter = frame.payload.length > 1 ? frame.payload[1] : null;
        this.emit('mode', { mode: MODE_NAMES[modeByte] ?? modeByte, filter });
        return;
      }
      case CMD.SCOPE: {
        if (frame.subCmd === SCOPE_SUBCMD.WAVEFORM_DATA) {
          this._scope.push(frame.data);
          return;
        }
        this.emit('unknown-frame', frame);
        return;
      }
      default:
        this.emit('unknown-frame', frame);
    }
  }

  /**
   * Send a command and wait for its reply. Requests are queued and sent
   * one at a time, since CI-V is a shared half-duplex bus.
   * @returns {Promise<object>} the parsed reply frame
   */
  _send(cmd, subCmd, data) {
    if (this.radioAddr === null || this.radioAddr === undefined) {
      return Promise.reject(
        new Error('radioAddr is not set; call detectRadioAddress() or pass it in opts')
      );
    }
    return new Promise((resolve, reject) => {
      const raw = encodeFrame({
        to: this.radioAddr,
        from: this.controllerAddr,
        cmd,
        subCmd,
        data,
      });
      this._queue.push({ raw, cmd, subCmd, resolve, reject });
      this._dequeueNext();
    });
  }

  _dequeueNext() {
    if (this._current || this._queue.length === 0) return;
    const job = this._queue.shift();
    this._current = job;
    job.timer = setTimeout(() => {
      this._current = null;
      job.reject(new Error(`CI-V request timed out (cmd 0x${job.cmd.toString(16)})`));
      this._dequeueNext();
    }, this.requestTimeoutMs);

    this.port.write(job.raw, (err) => {
      if (err) {
        clearTimeout(job.timer);
        this._current = null;
        job.reject(err);
        this._dequeueNext();
      }
    });
  }

  // ---- high-level rig control ---------------------------------------

  /** Read the current operating frequency in Hz. */
  async getFrequency() {
    const frame = await this._send(CMD.SEND_FREQ);
    this._throwIfNG(frame, 'read frequency');
    return bcdToFreq(frame.payload);
  }

  /** Set the operating frequency in Hz. */
  async setFrequency(hz) {
    const data = freqToBCD(hz);
    const frame = await this._send(CMD.SET_FREQ, undefined, data);
    this._throwIfNG(frame, 'set frequency');
    return true;
  }

  /** Read the current operating mode. */
  async getMode() {
    const frame = await this._send(CMD.SEND_MODE);
    this._throwIfNG(frame, 'read mode');
    const modeByte = frame.payload[0];
    const filter = frame.payload.length > 1 ? frame.payload[1] : null;
    return { mode: MODE_NAMES[modeByte] ?? modeByte, filter };
  }

  /**
   * Set the operating mode.
   *
   * Emits this driver's own 'mode' event the instant the radio confirms
   * the change (an OK reply to CMD.SET_MODE), rather than only ever
   * relying on the radio separately echoing it back later as an
   * unsolicited CMD.TRANSCEIVE_MODE notification (see _emitUnsolicited()).
   * That reliance was a real bug, not a hypothetical one: CwDecoderBridge
   * and RttyDecoderBridge both gate their behavior (CW/
   * RTTY decode activation) purely on this
   * driver's 'mode' event, but every mode change actually initiated
   * *through this app* (the CW mode chip, the mode row, FT8/FreeDV
   * entry/exit) went through this exact method — which never itself
   * emitted anything — so those bridges only ever found out about it if
   * the radio also happened to broadcast a transceive notification back.
   * Whether that happens depends on the radio's own "CI-V Transceive"
   * menu setting (off by default on some rigs/firmware, and not
   * necessarily sent for a mode-set command the radio received over the
   * very same CI-V bus rather than from its front panel), which this app
   * has no way to inspect or rely on. The practical symptom: an operator
   * clicks into CW mode, the UI shows it (app.js updates the chip
   * optimistically as soon as the request resolves, independent of any
   * server-side confirmation), but CwDecoderBridge's `_inCwMode` — driven
   * solely by the unsolicited event that may never arrive — silently
   * never flips, so it never attaches to the RX PCM stream at all, and
   * *no* CW decoder (CW1, CW2, or CW3 — all the same CwDecoderBridge code
   * path, see cw-decoder-bridge.js) ever sees a single sample, regardless
   * of how clean or strong the actual signal is. Exactly mirrors the fix
   * already applied to frequency changes for the identical reason (see
   * ws-server.js's SET_FREQUENCY handler's own doc comment) — the
   * difference is this one lives here, in the driver, rather than in
   * ws-server.js, because the affected bridges listen on *this*
   * object's 'mode' event directly rather than ControlServer's.
   *
   * A real subsequent transceive notification carrying the same value is
   * a harmless, idempotent duplicate — every listener here treats 'mode'
   * as "the current mode is now X", not an edge-triggered delta.
   *
   * @param {string|number} mode - mode name (e.g. 'USB') or raw mode byte
   * @param {number} [filter=1] - filter slot (1-3), if applicable
   */
  async setMode(mode, filter = 1) {
    const modeByte = typeof mode === 'number' ? mode : MODE[mode];
    if (modeByte === undefined) {
      throw new Error(`Unknown mode "${mode}"`);
    }
    const data = filter != null ? Buffer.from([modeByte, filter]) : Buffer.from([modeByte]);
    const frame = await this._send(CMD.SET_MODE, undefined, data);
    this._throwIfNG(frame, 'set mode');
    this.emit('mode', { mode: MODE_NAMES[modeByte] ?? modeByte, filter: filter ?? null });
    return true;
  }

  /**
   * Change the receive filter slot (1, 2, or 3) without changing the
   * current operating mode. There is no standalone "set filter" CI-V
   * command — filter selection is the second byte of the mode-set
   * command (0x06) alongside the mode byte itself (see setMode()), so
   * this reads the current mode first and resends it unchanged with the
   * new filter byte.
   */
  async setFilter(filterNum) {
    if (![1, 2, 3].includes(filterNum)) {
      throw new Error(`Invalid filter "${filterNum}" — must be 1, 2, or 3`);
    }
    const current = await this.getMode();
    return this.setMode(current.mode, filterNum);
  }

  /** Read the current receive filter slot (1, 2, or 3) — see setFilter(). */
  async getFilter() {
    const current = await this.getMode();
    return current.filter;
  }

  /**
   * Toggle the IC-7300's "DATA MODE" (CI-V 1A 05 00 63) — a setting
   * genuinely distinct from, and *in addition to*, the operating mode
   * itself (setMode('USB')). This is very likely the missing piece behind
   * "FT8 RX works but nothing I send is ever decoded by the other
   * station": on this radio, which audio input actually modulates the
   * transmitter is controlled by the "MOD Input" setting under
   * Menu > Set > Connectors, and the radio keeps *two separate*
   * MOD Input selections — one for DATA MODE OFF, one for DATA MODE ON —
   * so plain USB voice mode and USB **data** mode can each pull TX audio
   * from a different source (e.g. front-panel mic for DATA OFF, but the
   * USB codec for DATA ON). Simply calling setMode('USB') (what
   * enterFt8Mode() in app.js already did) puts the radio on the right
   * *operating* mode, but leaves DATA MODE itself off — meaning the
   * DATA-OFF MOD Input selection (commonly still the mic) stays in
   * effect, and audio this app writes to the USB codec never reaches the
   * transmitter at all. This would produce exactly the symptom reported:
   * PTT keys, a transmission duration elapses, but the far station never
   * decodes anything, because there's no FT8 tone in the RF actually
   * going out (or, if the mic is live, just room noise).
   *
   * On: 1 (this project only ever needs DATA1 — some Icom models accept
   * 2/3 for DATA2/DATA3, distinguishing further per-filter DATA MOD
   * Input options in the radio's menu structure, which this app has no
   * need for). Off: 0.
   *
   * VALUE WIDTH — corrected against real hardware: an earlier version of
   * this sent a single value byte (`[0x00, 0x63, on?1:0]`, 3 data bytes
   * total), reasoned only from the address being a well-corroborated
   * 2-byte parameter number, not from an actual read-back. A user's own
   * hardware diagnostic (test/manual-data-mode-diagnostics.js) against a
   * real IC-7300 showed the radio replies to a bare read of this
   * parameter with **4** data bytes — `[0x00, 0x63, 0x00, 0x01]` while
   * DATA MODE was known to be on — not 3, meaning the *value* itself is a
   * 2-byte field (`[0x00, 0x01]`, i.e. the setting's value BCD/digit
   * -packed across two bytes the same way several other "1A 05" extended
   * parameters do), not the single byte originally assumed. The single
   * -byte SET this project sent before didn't error (the radio replied
   * OK), but a follow-up read-back showed no actual change — consistent
   * with a short/malformed value field being silently tolerated but not
   * correctly applied. Sending the full 2-byte value field (`[0x00,
   * on?1:0]`) is the fix, matching the read reply's own structure
   * exactly. See docs/civ-notes.md's "DATA MODE" section for the full
   * diagnostic trace this was found from.
   *
   * IMPORTANT CAVEAT, same honesty this project applies to every other
   * CI-V byte layout (see docs/civ-notes.md): the "1A 05 00 63" address
   * and its 2-byte value-field width are now both confirmed against real
   * IC-7300 hardware (not just corroborating documentation), but whether
   * turning it on here actually routes audio to the transmitter still
   * depends on one thing this CI-V command **cannot** do: reach into the
   * radio's own menu and change what "MOD Input (DATA ON)" is set to. If
   * that menu setting isn't already USB on the actual radio, DATA MODE
   * being genuinely on via CI-V still won't route this app's audio to the
   * transmitter. See docs/ui-notes.md for exactly where to check that
   * menu setting.
   */
  async setDataMode(on) {
    const data = Buffer.from([...DATA_MODE_PARAM_BYTES, 0x00, on ? 1 : 0]);
    const frame = await this._send(CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, data);
    this._throwIfNG(frame, 'set data mode');
    return true;
  }

  /** Read back whether DATA MODE is currently on — see setDataMode(). */
  async getDataMode() {
    const data = Buffer.from(DATA_MODE_PARAM_BYTES);
    const frame = await this._send(CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, data);
    this._throwIfNG(frame, 'read data mode');
    // frame.data is everything after the subCmd byte (0x05) — i.e. the
    // echoed 2-byte parameter number followed by the actual 2-byte value
    // field (see setDataMode()'s doc comment for how this width was
    // confirmed against real hardware — it is NOT a single value byte).
    if (!frame.data || frame.data.length < 4) {
      throw new Error('Unexpected data-mode reply format (older firmware may not support reading this back)');
    }
    return frame.data[3] !== 0;
  }

  /**
   * Set the radio's own "AF output level to ACC/USB" (CI-V 1A 05 00 60)
   * — how loud the radio's RX audio is when it's sent out over the USB
   * (and ACC) audio interface. This is a setting *inside the
   * transceiver*, entirely separate from both the front-panel volume
   * knob and this project's own Linux-side `amixer` capture/playback
   * gain maximization (see docs/audio-notes.md) — that one maximizes the
   * USB codec's ALSA controls as the Pi sees them; this one maximizes
   * the level the radio itself puts onto that same USB link in the first
   * place. Both matter for a predictable, clipping-free audio path.
   *
   * Byte layout follows the exact same "1A 05" two-part addressing
   * already confirmed for DATA MODE (a 2-byte parameter number —
   * AF_OUTPUT_LEVEL_USB_PARAM_BYTES — followed by a 2-byte value field;
   * see setDataMode()'s doc comment) — but unlike DATA_MODE's plain 0/1
   * value, this is a genuine 0-255 continuous level, so the value field
   * uses the different "hundreds-digit nibble + BCD byte" packing
   * already hardware-confirmed for S-meter/TX power/RX gain
   * (`_encodeMeterValue()`), not DATA MODE's own encoding. The address
   * and this worked example (0-255 -> `02 55` for max) were given
   * directly from a real IC-7300, which is why this defaults to exactly
   * that value when called with no argument — see
   * src/server/index.js, which calls this once at startup.
   * @param {number} [value=255] - 0-255
   */
  async setAfOutputLevelUsb(value = 255) {
    const data = Buffer.concat([Buffer.from(AF_OUTPUT_LEVEL_USB_PARAM_BYTES), this._encodeMeterValue(value)]);
    const frame = await this._send(CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, data);
    this._throwIfNG(frame, 'set AF output level (ACC/USB)');
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  /** Read back the current "AF output level to ACC/USB" — see setAfOutputLevelUsb(). */
  async getAfOutputLevelUsb() {
    const data = Buffer.from(AF_OUTPUT_LEVEL_USB_PARAM_BYTES);
    const frame = await this._send(CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, data);
    this._throwIfNG(frame, 'read AF output level (ACC/USB)');
    // frame.data is everything after the subCmd byte: the echoed 2-byte
    // parameter number followed by the actual 2-byte value field — same
    // 4-byte-total shape as DATA MODE's own reply (see getDataMode()).
    if (!frame.data || frame.data.length < 4) {
      throw new Error('Unexpected AF output level (ACC/USB) reply format (older firmware may not support reading this back)');
    }
    return this._decodeMeterReply({ data: frame.data.subarray(2, 4) }, 'AF output level (ACC/USB)');
  }

  /**
   * Set the radio's own "MOD input level from USB" (CI-V 1A 05 00 65) —
   * how sensitive the radio is to audio arriving over USB as a
   * modulation source, i.e. this app's own FT8/voice TX audio. Sibling
   * setting to setAfOutputLevelUsb() (same "1A 05" address family, same
   * 0-255 meter-style value encoding, same real-hardware-given worked
   * example) — see that method's doc comment for the full byte-layout
   * reasoning, which applies here unchanged.
   * @param {number} [value=255] - 0-255
   */
  async setModInputLevelUsb(value = 255) {
    const data = Buffer.concat([Buffer.from(MOD_INPUT_LEVEL_USB_PARAM_BYTES), this._encodeMeterValue(value)]);
    const frame = await this._send(CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, data);
    this._throwIfNG(frame, 'set MOD input level (from USB)');
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  /** Read back the current "MOD input level from USB" — see setModInputLevelUsb(). */
  async getModInputLevelUsb() {
    const data = Buffer.from(MOD_INPUT_LEVEL_USB_PARAM_BYTES);
    const frame = await this._send(CMD.OPTIONAL, OPTIONAL_SUBCMD.DATA_MODE, data);
    this._throwIfNG(frame, 'read MOD input level (from USB)');
    if (!frame.data || frame.data.length < 4) {
      throw new Error('Unexpected MOD input level (from USB) reply format (older firmware may not support reading this back)');
    }
    return this._decodeMeterReply({ data: frame.data.subarray(2, 4) }, 'MOD input level (from USB)');
  }

  /** Key or unkey the transmitter. */
  async setPtt(on) {
    const frame = await this._send(CMD.PTT, SUBCMD.PTT, Buffer.from([on ? 1 : 0]));
    this._throwIfNG(frame, 'set PTT');
    return true;
  }

  /**
   * Control the antenna tuner: 0=OFF, 1=ON, 2=start tuning now. Unlike
   * the other 0/1 values, 2 is a one-shot trigger, not a state that
   * persists/reads back as "2" afterward — the radio runs its tune cycle
   * and the tuner setting effectively returns to ON (or OFF, if tuning
   * failed) once it completes. Callers wanting a "Tune" action button
   * (as opposed to an on/off toggle) should call this with 2.
   */
  async setTuner(value) {
    if (![0, 1, 2].includes(value)) {
      throw new Error(`Invalid tuner value "${value}" — must be 0 (OFF), 1 (ON), or 2 (start tuning)`);
    }
    const frame = await this._send(CMD.PTT, SUBCMD.TUNER, Buffer.from([value]));
    this._throwIfNG(frame, 'set tuner');
    return true;
  }

  /**
   * Set the RF preamp: 0=OFF, 1=Preamp 1 ON, 2=Preamp 2 ON. See
   * FUNCTION_SUBCMD's doc comment in commands.js for the byte format.
   */
  async setPreamp(value) {
    if (![0, 1, 2].includes(value)) {
      throw new Error(`Invalid preamp value "${value}" — must be 0 (OFF), 1 (Amp 1), or 2 (Amp 2)`);
    }
    const frame = await this._send(CMD.FUNCTION, FUNCTION_SUBCMD.PREAMP, Buffer.from([value]));
    this._throwIfNG(frame, 'set preamp');
    return true;
  }

  /** Turn the noise reduction function on/off. */
  async setNoiseReduction(on) {
    const frame = await this._send(CMD.FUNCTION, FUNCTION_SUBCMD.NOISE_REDUCTION, Buffer.from([on ? 1 : 0]));
    this._throwIfNG(frame, 'set noise reduction');
    return true;
  }

  /** Turn the noise blanker function on/off. */
  async setNoiseBlanker(on) {
    const frame = await this._send(CMD.FUNCTION, FUNCTION_SUBCMD.NOISE_BLANKER, Buffer.from([on ? 1 : 0]));
    this._throwIfNG(frame, 'set noise blanker');
    return true;
  }

  /**
   * Turn the notch function on/off. Maps to the *auto* notch sub-command
   * — see FUNCTION_SUBCMD's doc comment in commands.js for why, versus
   * the also-available manual notch.
   */
  async setNotch(on) {
    const frame = await this._send(CMD.FUNCTION, FUNCTION_SUBCMD.AUTO_NOTCH, Buffer.from([on ? 1 : 0]));
    this._throwIfNG(frame, 'set notch');
    return true;
  }

  /**
   * Read back the actual current value of a simple single-byte
   * CMD/SUBCMD setting — a bare read request (no data bytes), matching
   * the convention used throughout this project (e.g. getScopeSpan()).
   * Shared helper since getPreamp/getNoiseReduction/getNoiseBlanker/
   * getNotch/getTuner are all otherwise identical single-byte reads.
   */
  async _readSingleByteSetting(cmd, subCmd, label) {
    const frame = await this._send(cmd, subCmd); // no data = read request
    this._throwIfNG(frame, `read ${label}`);
    if (!frame.data || frame.data.length < 1) {
      throw new Error(`Unexpected ${label} reply (no data)`);
    }
    return frame.data[0];
  }

  /** Read the preamp's actual current value: 0=OFF, 1=Amp 1, 2=Amp 2. */
  async getPreamp() {
    return this._readSingleByteSetting(CMD.FUNCTION, FUNCTION_SUBCMD.PREAMP, 'preamp');
  }

  /** Read the noise reduction function's actual current on/off state. */
  async getNoiseReduction() {
    return (await this._readSingleByteSetting(CMD.FUNCTION, FUNCTION_SUBCMD.NOISE_REDUCTION, 'noise reduction')) === 1;
  }

  /** Read the noise blanker function's actual current on/off state. */
  async getNoiseBlanker() {
    return (await this._readSingleByteSetting(CMD.FUNCTION, FUNCTION_SUBCMD.NOISE_BLANKER, 'noise blanker')) === 1;
  }

  /** Read the (auto) notch function's actual current on/off state. */
  async getNotch() {
    return (await this._readSingleByteSetting(CMD.FUNCTION, FUNCTION_SUBCMD.AUTO_NOTCH, 'notch')) === 1;
  }

  /**
   * Read the antenna tuner's actual current on/off state. Only ever
   * reads back 0 or 1 in practice — "2" (start tuning) is a momentary
   * trigger, not a state the radio holds/reports (see setTuner's doc
   * comment) — but the raw byte is still returned as-is rather than
   * coerced to boolean, in case a radio's firmware ever does report it.
   */
  async getTuner() {
    return this._readSingleByteSetting(CMD.PTT, SUBCMD.TUNER, 'tuner');
  }

  /**
   * Shared decode for CMD.READ_SMETER's family of meter reads (S-meter,
   * SWR — both under command 0x15, different sub-commands). Confirmed
   * against real hardware for S-meter specifically by correlating raw
   * byte captures against the radio's own front-panel reading (see
   * docs/civ-notes.md for the full story). The format is **not** the
   * standard little-endian BCD pair convention used elsewhere in this
   * project (e.g. frequency):
   *
   *   byte[0] & 0x0F  = the hundreds digit (0, 1, or 2 — the full
   *                     0-255 range never needs more than 3 decimal
   *                     digits)
   *   byte[1]         = the tens+ones digits, as a 2-digit BCD byte
   *   value = 100 * (byte[0] & 0x0F) + BCD(byte[1])
   */
  _decodeMeterReply(frame, label) {
    if (!frame.data || frame.data.length < 2) {
      throw new Error(`Unexpected ${label} reply (fewer than 2 data bytes)`);
    }
    const [byte0, byte1] = frame.data;
    const hundreds = byte0 & 0x0f;
    const tensOnes = bcdToFreq(Buffer.from([byte1]));
    const value = hundreds * 100 + tensOnes;
    if (!Number.isFinite(value) || value < 0 || value > 255) {
      throw new Error(
        `${label} reply decoded to an out-of-range value (${value}) — likely a byte-format mismatch on this radio/firmware. See docs/civ-notes.md and test/manual-smeter-diagnostics.js.`
      );
    }
    return value;
  }

  /**
   * Inverse of `_decodeMeterReply()` — encodes a 0-255 value into the
   * same 2-byte format (hundreds-digit nibble + 2-digit BCD byte).
   */
  _encodeMeterValue(value) {
    const clamped = Math.max(0, Math.min(255, Math.round(value)));
    const hundreds = Math.floor(clamped / 100);
    const tensOnes = clamped % 100;
    return Buffer.from([hundreds, freqToBCD(tensOnes, 1)[0]]);
  }

  /**
   * Read the S-meter level (rig-dependent scale, typically 0-255). This
   * is the third attempt at this method, and the first one actually
   * confirmed against real hardware rather than reasoned from a symptom
   * description — see `_decodeMeterReply()`'s doc comment for the byte
   * format, and docs/civ-notes.md for the full correction history.
   */
  async getSMeter() {
    const frame = await this._send(CMD.READ_SMETER, SUBCMD.SMETER);
    this._throwIfNG(frame, 'read S-meter');
    return this._decodeMeterReply(frame, 'S-meter');
  }

  /**
   * Read the SWR meter level, raw 0-255 (same command group as S-meter,
   * different sub-command: `27 15 12`... — `CMD.READ_SMETER`,
   * `SUBCMD.SWR`). Icom's official CI-V reference manual documents three
   * reference points for this command: `00 00` = SWR 1.0, `00 48` =
   * SWR 1.5, `00 80` = SWR 2.0, `01 20` = SWR 3.0. Decoding those same
   * example bytes with the S-meter's confirmed byte format
   * (`_decodeMeterReply()`, i.e. NOT the standard little-endian BCD pair
   * used elsewhere in this project) gives clean, round raw values: 0,
   * 48, 80, and 120 respectively — strong circumstantial evidence this
   * command shares S-meter's encoding, since both live under the same
   * command group and are documented in the exact same table style.
   * That's not the same as independent confirmation the way S-meter
   * itself now has, though: this hasn't been correlated against a real
   * radio's actual VSWR reading during transmit the way S-meter was
   * against the front-panel S-meter. Worth bench-testing against a
   * dummy load with a known SWR if this matters for your use. See
   * `docs/civ-notes.md` and `src/client/vswr.js` for how this raw value
   * is converted into a displayed SWR number and color zone.
   */
  async getSWR() {
    const frame = await this._send(CMD.READ_SMETER, SUBCMD.SWR);
    this._throwIfNG(frame, 'read SWR');
    return this._decodeMeterReply(frame, 'SWR');
  }

  /**
   * Set transmit power, in watts. The CI-V level itself is raw 0-255
   * ("00 00 to 02 55" per the manual); there's no direct watts field, so
   * this assumes a simple linear relationship between the raw level and
   * output watts, scaled against `maxWatts` (100W — the IC-7300's rated
   * HF/6m maximum). This linear assumption is unverified either way (see
   * docs/civ-notes.md) — but the byte *encoding* itself was verified
   * wrong on real hardware: a first attempt used this project's standard
   * little-endian BCD pair (`freqToBCD`), and every write was rejected
   * outright (NG). Reasoned root cause: for high values that encoding
   * puts a byte with an invalid "hundreds" nibble first (e.g. raw 255
   * -> `[0x55, 0x02]`, whose first byte's low nibble is 5 — not a valid
   * hundreds digit for a 0-255 range), which a validating radio would
   * plausibly reject outright, unlike a read that just returns wrong
   * data. This now reuses the exact packing already hardware-confirmed
   * for S-meter/SWR instead (`_encodeMeterValue()`/`_decodeMeterReply()`)
   * — a well-reasoned correction, but only real hardware testing can
   * confirm it, the same way S-meter's fix ultimately needed. If this is
   * still rejected, run `test/manual-txpower-diagnostics.js`: it tries
   * several candidate encodings as plain writes (never engaging PTT, so
   * nothing is actually transmitted) and reports which the radio
   * accepts, the same non-destructive approach that resolved the scope
   * span command.
   */
  async setTxPower(watts, maxWatts = 100) {
    const raw = Math.max(0, Math.min(255, Math.round((watts / maxWatts) * 255)));
    const frame = await this._send(CMD.LEVEL, LEVEL_SUBCMD.RF_PWR, this._encodeMeterValue(raw));
    this._throwIfNG(frame, 'set TX power');
    return Math.round((raw / 255) * maxWatts);
  }

  /** Read the current transmit power level back, in watts — see setTxPower(). */
  async getTxPower(maxWatts = 100) {
    const frame = await this._send(CMD.LEVEL, LEVEL_SUBCMD.RF_PWR);
    this._throwIfNG(frame, 'read TX power');
    const raw = this._decodeMeterReply(frame, 'TX power');
    return Math.round((raw / 255) * maxWatts);
  }

  /**
   * Set the RX (RF) gain, raw 0-255 — no unit conversion, unlike
   * setTxPower()'s watts scaling, since the UI exposes this as the raw
   * 0-255 range directly. See LEVEL_SUBCMD's doc comment in commands.js
   * for the byte-encoding reasoning (reused from S-meter/TX power,
   * not independently confirmed for this specific field).
   */
  async setRxGain(value) {
    const raw = Math.max(0, Math.min(255, Math.round(value)));
    const frame = await this._send(CMD.LEVEL, LEVEL_SUBCMD.RF_GAIN, this._encodeMeterValue(raw));
    this._throwIfNG(frame, 'set RX gain');
    return raw;
  }

  /** Read the current RX (RF) gain back, raw 0-255 — see setRxGain(). */
  async getRxGain() {
    const frame = await this._send(CMD.LEVEL, LEVEL_SUBCMD.RF_GAIN);
    this._throwIfNG(frame, 'read RX gain');
    return this._decodeMeterReply(frame, 'RX gain');
  }

  /**
   * Read the radio's configured CW pitch (sidetone/RX filter center
   * frequency), in Hz. Per Icom's official manual: raw 0-255 maps
   * linearly to 300-900Hz in 5Hz steps (`0000=300Hz, 0128=600Hz,
   * 0255=900Hz`). Same command group as TX power/RX gain (`CMD.LEVEL`),
   * so uses the same meter-style byte packing from the start, for the
   * same reasoning documented on `getRxGain()`/`LEVEL_SUBCMD`.
   *
   * Used by the CW decoder (`src/audio/cw-decoder.js` via
   * `src/server/cw-decoder-bridge.js`) to automatically tune its tone
   * detector to whatever pitch the radio is actually configured for,
   * rather than requiring a separate manually-maintained setting.
   */
  async getCwPitch() {
    const frame = await this._send(CMD.LEVEL, LEVEL_SUBCMD.CW_PITCH);
    this._throwIfNG(frame, 'read CW pitch');
    const raw = this._decodeMeterReply(frame, 'CW pitch');
    // Snapped to the documented 5Hz step grid, matching the manual's
    // three reference points (raw 0/128/255 -> 300/600/900Hz) exactly —
    // a plain linear round (no snapping) is off by 1Hz at raw=128,
    // immaterial for tuning a Goertzel filter but worth getting right.
    return Math.round((300 + (raw * 600) / 255) / 5) * 5;
  }


  /** Turn the radio's own scope display on/off. */
  async setScopeOnOff(on) {
    const frame = await this._send(CMD.SCOPE, SCOPE_SUBCMD.ON_OFF, Buffer.from([on ? 1 : 0]));
    this._throwIfNG(frame, 'set scope on/off');
    return true;
  }

  /** Turn CI-V waveform data output on/off (independent of the scope display itself). */
  async setScopeDataOutput(on) {
    const frame = await this._send(CMD.SCOPE, SCOPE_SUBCMD.DATA_OUTPUT, Buffer.from([on ? 1 : 0]));
    this._throwIfNG(frame, 'set scope data output');
    return true;
  }

  /**
   * Convenience: enables both the scope display and CI-V waveform data
   * output, which per Icom's documentation is required for 'scope-line'
   * events to start firing. Real-world reliability varies — see
   * docs/civ-notes.md.
   */
  async enableScopeOutput() {
    await this.setScopeOnOff(true);
    await this.setScopeDataOutput(true);
  }

  /** Stops CI-V waveform data output (leaves the radio's own scope display alone). */
  async disableScopeOutput() {
    await this.setScopeDataOutput(false);
  }

  /**
   * Set the scope to Center, Fixed, Scroll-C, or Scroll-F mode (see
   * SCOPE_MODE). Data is 2 bytes: a fixed 0x00 byte followed by the mode
   * value — confirmed against Icom's official IC-7300 CI-V reference
   * manual (p.19-14), which shows this exact "00 XX" structure for this
   * command (and the same pattern for 27 17/27 1A). An earlier version
   * sent only 1 byte (the mode value alone, no leading 0x00) — not
   * rejected outright, but not confirmed correct either; corrected here
   * to match the documented format exactly.
   */
  async setScopeMode(mode) {
    const modeByte = typeof mode === 'number' ? mode : SCOPE_MODE[String(mode).toUpperCase()];
    if (modeByte === undefined) {
      throw new Error(`Unknown scope mode "${mode}"`);
    }
    const frame = await this._send(CMD.SCOPE, SCOPE_SUBCMD.MODE, Buffer.from([0x00, modeByte]));
    this._throwIfNG(frame, 'set scope mode');
    return true;
  }

  /**
   * Set the Center/Scroll-C mode span. The radio only accepts one of
   * SCOPE_SPAN_PRESETS_HZ — not an arbitrary Hz value — so `hz` is
   * rounded up to the smallest preset that is >= the requested value
   * (capped at the largest preset) before sending, and the
   * actually-applied value is returned so callers/UI can reflect reality
   * rather than what was merely asked for.
   *
   * Byte format, per Icom's own official IC-7300 CI-V reference manual
   * (Section 19, p.19-14 "Scope span settings"): the value is the span
   * **directly in Hz** (2500-500000, matching SCOPE_SPAN_PRESETS_HZ
   * exactly — confirmed against the manual's own reference table, not
   * reasoned from a digit-position diagram alone), encoded as a fixed
   * 0x00 prefix byte followed by this project's already
   * hardware-verified 5-byte little-endian BCD frequency encoding
   * (freqToBCD(value, 5) — the exact same routine proven correct against
   * a real radio for the main frequency field). This corrects an earlier
   * version that used a single-byte *index* (0-7) — reasoned from a
   * less authoritative online source that turned out wrong on two
   * counts: the value itself (index vs. direct Hz) and, consequently,
   * the byte layout. The exact byte *position* of the encoded value
   * within the 6-byte payload (assumed here: right after the single
   * prefix byte) is a well-reasoned but not independently
   * hardware-confirmed placement — see docs/civ-notes.md and
   * test/manual-scope-span-diagnostics.js if this still doesn't work.
   */
  async setScopeSpan(hz) {
    let index = SCOPE_SPAN_PRESETS_HZ.findIndex((preset) => preset >= hz);
    if (index === -1) index = SCOPE_SPAN_PRESETS_HZ.length - 1;
    const applied = SCOPE_SPAN_PRESETS_HZ[index];

    const data = Buffer.concat([Buffer.from([0x00]), freqToBCD(applied, 5)]);
    const frame = await this._send(CMD.SCOPE, SCOPE_SUBCMD.SPAN, data);
    this._throwIfNG(frame, 'set scope span');
    return applied;
  }

  /**
   * Read the current Center/Scroll-C mode span back from the radio, in
   * Hz. Same byte format as setScopeSpan(): a fixed 0x00 prefix byte
   * followed by the value directly BCD-encoded (5 bytes, this project's
   * standard little-endian convention).
   */
  async getScopeSpan() {
    const frame = await this._send(CMD.SCOPE, SCOPE_SUBCMD.SPAN); // no data = read request
    this._throwIfNG(frame, 'read scope span');
    if (!frame.data || frame.data.length < 6) {
      throw new Error('Unexpected scope span reply format (older firmware may not support reading this back)');
    }
    return bcdToFreq(frame.data.subarray(1, 6));
  }

  /**
   * Convenience: switches to Center mode and sets the span to comfortably
   * cover [lowHz, highHz] (rounding up to the nearest allowed span
   * preset). Center mode's displayed center always tracks the currently
   * tuned VFO frequency (it isn't independently settable) — so this only
   * makes sense to call once the VFO is already tuned somewhere sensible
   * within the target range, e.g. right after setFrequency(). Bands wider
   * than 500kHz (the largest span preset) will be clamped and won't fit
   * in one screen — see docs/civ-notes.md.
   * @returns {Promise<number>} the span actually applied, in Hz
   */
  async tuneScopeToRange(lowHz, highHz) {
    await this.setScopeMode(SCOPE_MODE.CENTER);
    return this.setScopeSpan(Math.max(0, highHz - lowHz));
  }

  /**
   * Convenience: switches to Center mode with a fixed span (default
   * 100kHz — one of the radio's own official presets, per the CI-V
   * reference manual, not a "+/-" half-width). Unlike
   * tuneScopeToRange(), this doesn't need a target frequency at all —
   * Center mode's displayed center always tracks whatever the VFO is
   * currently tuned to, automatically, on the radio itself. So calling
   * this once (e.g. when scope output is enabled) is enough to get a
   * "N kHz around wherever I'm tuned" view that keeps itself centered
   * through every subsequent frequency change — band clicks, direct
   * entry, even the front panel — with no need to re-issue any command
   * per change.
   * @returns {Promise<number>} the span actually applied, in Hz
   */
  async centerScope(spanHz = 100000) {
    await this.setScopeMode(SCOPE_MODE.CENTER);
    return this.setScopeSpan(spanHz);
  }

  /**
   * Auto-detect the radio's CI-V address by querying the broadcast
   * address (0x00) and reading who replies. Only works reliably when
   * exactly one radio is on the bus. Sets this.radioAddr on success.
   * @returns {Promise<number>} the detected address
   */
  async detectRadioAddress() {
    const previous = this.radioAddr;
    this.radioAddr = BROADCAST_ADDR;
    try {
      const frame = await this._send(CMD.READ_TRANSCEIVER_ID, SUBCMD.TRANSCEIVER_ID);
      if (frame.cmd !== CMD.READ_TRANSCEIVER_ID) {
        throw new Error('Unexpected reply while detecting radio address');
      }
      this.radioAddr = frame.from;
      return frame.from;
    } catch (err) {
      this.radioAddr = previous;
      throw err;
    }
  }

  _throwIfNG(frame, what) {
    if (frame.cmd === CMD.NG) {
      throw new Error(`Radio rejected request: ${what}`);
    }
  }
}

module.exports = { CivDriver };
