'use strict';

/**
 * HamDRM (EasyPal / QSSTV "DRM" digital SSTV) receiver: radio audio in,
 * received files out. The receiver is a JavaScript port of QSSTV's drmrx
 * (see the other files in this folder); this file is its front end, like
 * QSSTV's drmrx.cpp: decimate to 12 kHz, make the complex signal with
 * QSSTV's Hilbert filter, and feed the demodulator in 1024-sample blocks.
 *
 * Portions copyright (C) 2000-2019 Johan Maes (ON4QZ); GPL-2.0-or-later.
 * See third_party/qsstv-drm/README.md.
 */

const { StreamDecimator } = require('../decimator');
const T = require('./tables');
const { Demodulator } = require('./demodulator');
const { ChannelDecoder } = require('./channel-decoder');
const { SourceDecoder } = require('./source-decoder');

const RATE = 12000;
const BLOCK = 1024;

// QSSTV's drmHilbertCoef (dsp/filterparam.cpp), taps 1, 3, ... 75; the
// filter is antisymmetric about tap 76 and the even taps are zero.
const HILBERT_HALF = [
  0.00107190601522455, 0.00114428127836931, 0.00126465142463967, 0.00143657040680006, 0.00166370297755838, 0.00194984843584138,
  0.00229897112682306, 0.00271523918124115, 0.00320307336657778, 0.00376720843252962, 0.00441277001061758, 0.00514537103613413,
  0.00597123289056438, 0.00689733814551449, 0.00793162411788592, 0.00908322970767581, 0.0103628126183723, 0.0117829607223439,
  0.0133587310729627, 0.015108364544715, 0.0170542460109686, 0.0192242138609088, 0.0216533762307932, 0.0243866781537711,
  0.027482608550733, 0.0310186849032487, 0.035099797177604, 0.0398713166388587, 0.0455404799655691, 0.0524128630218771,
  0.0609580273296193, 0.0719357553084729, 0.0866599865154828, 0.10761465561151, 0.140125234561542, 0.198041949770117,
  0.332155822226347, 0.999607048858159,
];
const HILBERT_TAPS = 153;
const HILBERT_GAIN = 1.569749;
const HILBERT = new Float64Array(HILBERT_TAPS);
HILBERT_HALF.forEach((c, i) => {
  HILBERT[2 * i + 1] = c / HILBERT_GAIN;
  HILBERT[HILBERT_TAPS - 2 - 2 * i] = -c / HILBERT_GAIN;
});

const QAM_NAMES = { 0: 64, 1: 16, 3: 4 };
// QSSTV's transmitter (from Dream) puts the OFDM block's centre (DC, an
// unused carrier) at 350 Hz audio; the receiver reports how far off that the
// signal is, which is how far the radio is mistuned (or the sender is).
const NOMINAL_DC_HZ = 350;

/** Mode code as QSSTV logs it: mode, bandwidth, protection, QAM, interleave. */
function describeMode(fac, mode) {
  if (!fac || mode == null || mode > 2) return null;
  return {
    mode: T.MODE_NAMES[mode],
    bandwidth: fac.spectrumOccupancy ? 2.5 : 2.3,
    qam: QAM_NAMES[fac.mscMode] || null,
    protection: fac.protection ? 'normal' : 'high',
    interleave: fac.interleaver ? 'short' : 'long',
  };
}

class HamDrmReceiver {
  /**
   * @param {object} opts
   * @param {number} [opts.sampleRate=48000] input rate, a multiple of 12000
   * @param {(ev:object) => void} opts.onEvent {type:'status'|'header'|'segment'|'file'|'lost', ...}
   */
  constructor({ sampleRate = 48000, onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.decimator = new StreamDecimator(sampleRate, RATE, { cutoffHz: 4500, taps: 97 });
    this.hist = new Float64Array(HILBERT_TAPS); // newest first, circular
    this.hpos = 0;
    this.block = new Float64Array(2 * BLOCK);
    this.fill = 0;
    this.g = {
      transmission_frame_buffer: new Float64Array(82980),
      channel_transfer_function_buffer: new Float64Array(82980),
      transmission_frame_buffer_wptr: 0,
      transmission_frame_buffer_data_valid: 0,
      robustness_mode: 99,
      spectrum_occupancy: -1,
      symbols_per_frame: 15,
      K_dc: 0,
      K_modulo: 0,
      FAC_cells_k: [],
      lFAC: 0,
      fac_valid: -1,
      WMERFAC: 0,
      mean_energy_of_used_cells: 1,
    };
    this.demod = new Demodulator(this.g);
    this.channel = new ChannelDecoder(this.g);
    this.demod.onResync = () => this._lost();
    this.source = new SourceDecoder({
      onHeader: (h) => this.onEvent({ type: 'header', ...h }),
      onSegment: (s) => this.onEvent({ type: 'segment', ...s }),
      onFile: (f) => this.onEvent({ type: 'file', ...f }),
    });
    this.frames = 0;
    this.goodFrames = 0;
    this.locked = false;
    this.snr = null;
  }

  /** Audio in (Float32 -1..1 or Int16), any length. */
  process(samples) {
    const x = this.decimator.process(samples);
    const h = this.hist;
    for (let n = 0; n < x.length; n++) {
      this.hpos = (this.hpos + HILBERT_TAPS - 1) % HILBERT_TAPS;
      h[this.hpos] = x[n];
      let r = 0;
      for (let i = 1; i < HILBERT_TAPS; i += 2) {
        let k = this.hpos + i;
        if (k >= HILBERT_TAPS) k -= HILBERT_TAPS;
        r += h[k] * HILBERT[i];
      }
      let d = this.hpos + 76;
      if (d >= HILBERT_TAPS) d -= HILBERT_TAPS;
      this.block[2 * this.fill] = r;
      this.block[2 * this.fill + 1] = h[d];
      if (++this.fill === BLOCK) {
        this.fill = 0;
        this._run();
      }
    }
  }

  _run() {
    const onFrame = () => this._frame();
    if (this.demod.input_samples_buffer_request === 0) this.demod.demodulate(null, 0, onFrame);
    this.demod.demodulate(this.block, BLOCK, onFrame);
  }

  _frame() {
    this.frames++;
    const g = this.g;
    this.snr = Number.isFinite(g.WMERFAC) ? g.WMERFAC : null;
    const out = this.channel.decode();
    let packetOk = null;
    if (out) {
      const fac = this.channel.fac;
      packetOk = this.source.decode(out.bits, {
        callsign: this.channel.callsign,
        modeCode: describeMode(fac, g.robustness_mode),
      });
      if (packetOk) this.goodFrames++;
    }
    const fac = g.fac_valid === 1 ? this.channel.fac : null;
    if (fac) this.locked = true;
    const cur = this.source.current;
    this.onEvent({
      type: 'status',
      stage: fac ? 'receiving' : 'sync',
      snr: this.snr,
      mode: describeMode(fac, g.robustness_mode),
      callsign: this.channel.callsign || '',
      frequencyOffsetHz: this.demod.frequencyOffsetHz,
      tuningHz: this.demod.frequencyOffsetHz - NOMINAL_DC_HZ,
      packetOk,
      file: cur && !cur.done ? this.source.progress(cur) : null,
    });
  }

  _lost() {
    this.source.init();
    if (this.locked) {
      this.locked = false;
      this.onEvent({ type: 'lost' });
    }
  }

  /** Forget everything (new frequency, or the user pressed Stop). */
  reset() {
    this.demod.init();
    this.channel.init();
    this.source.init();
    this.source.transports = [];
    this.decimator.reset();
    this.hist.fill(0);
    this.fill = 0;
    this.locked = false;
  }
}

module.exports = { HamDrmReceiver, describeMode, HILBERT, RATE, NOMINAL_DC_HZ };
