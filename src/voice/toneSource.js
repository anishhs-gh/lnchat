'use strict';

const events = require('events');
const { SAMPLE_RATE, FRAME_MS, FRAME_SAMPLES } = require('./audioFormat');

const FRAME_SIZE = FRAME_SAMPLES;

// A stand-in microphone for Phase 2: emits a continuous sine-wave PCM stream
// ('frame' events carrying Int16Array) at the same 48 kHz / 20 ms cadence the
// real capture path will use. In Phase 3 the naudiodon2 mic input replaces this
// behind the identical interface — start(), stop(), and 'frame' events — so the
// CallManager wiring does not change.
//
// Caller and callee use different frequencies so that, when verifying the duplex
// path, each side can confirm it is hearing the *other* end and not its own echo.
class ToneSource extends events.EventEmitter {
  constructor(freq = 440) {
    super();
    this._freq  = freq;
    this._phase = 0;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    const inc = (2 * Math.PI * this._freq) / SAMPLE_RATE;
    this._timer = setInterval(() => {
      const frame = new Int16Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        frame[i] = Math.round(Math.sin(this._phase) * 0.25 * 32767); // -12 dBFS
        this._phase += inc;
        if (this._phase > 2 * Math.PI) this._phase -= 2 * Math.PI;
      }
      this.emit('frame', frame);
    }, FRAME_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = ToneSource;
module.exports.SAMPLE_RATE = SAMPLE_RATE;
module.exports.FRAME_SIZE  = FRAME_SIZE;
