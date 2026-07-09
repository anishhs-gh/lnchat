'use strict';

// A small playout buffer that turns jittery, possibly-reordered UDP audio frames
// into a clean in-order stream for the speaker.
//
//   • Prebuffer: hold `target` frames before playout starts, so a burst of early
//     network jitter doesn't cause an immediate underrun.
//   • Reorder: frames are keyed by their sequence number and emitted strictly in
//     order, so an out-of-order arrival is placed correctly.
//   • Conceal: if we stall waiting for a missing frame while the buffer keeps
//     filling past `max`, we give up on the gap, emit one silence frame in its
//     place, and skip ahead — a lost packet becomes a 20 ms blip, never a stall.
//
// It is driven entirely by push() (the network thread). The speaker/PortAudio
// output is the real clock; the prebuffer gives it the head-start it needs. This
// avoids running a second timer that could drift against the audio hardware.
//
// Sequence numbers are BigInt (matching MediaSocket's 64-bit counter).
const { FRAME_SAMPLES } = require('./audioFormat');

class JitterBuffer {
  // Defaults are sized for 10 ms frames: target 4 ≈ 40 ms prebuffer, max 16 ≈
  // 160 ms before a lost frame is concealed and skipped.
  constructor(onFrame, { target = 4, max = 16, frameSamples = FRAME_SAMPLES } = {}) {
    this._onFrame      = onFrame;
    this._target       = target;
    this._max          = max;
    this._frameSamples = frameSamples;

    this._frames  = new Map();   // seqString → Int16Array
    this._next    = null;        // next seq to emit (BigInt), null until started
    this._started = false;

    this.played    = 0;          // frames emitted from real audio
    this.concealed = 0;          // silence frames emitted for lost packets
  }

  push(seq, samples) {
    // Already played past this point — a very late frame; drop it.
    if (this._next !== null && seq < this._next) return;

    this._frames.set(seq.toString(), samples);

    if (!this._started) {
      if (this._frames.size < this._target) return; // still prebuffering
      this._started = true;
      this._next    = this._minSeq();
    }
    this._drain();
  }

  _drain() {
    for (;;) {
      const key = this._next.toString();
      if (this._frames.has(key)) {
        const f = this._frames.get(key);
        this._frames.delete(key);
        this._onFrame(f);
        this.played++;
        this._next += 1n;
        continue;
      }
      // The next frame isn't here. Only give up (conceal + skip) once the backlog
      // has grown past `max` — until then we wait for it to arrive late.
      if (this._frames.size > this._max) {
        this._onFrame(this._silence());
        this.concealed++;
        this._next += 1n;
        continue;
      }
      break;
    }
  }

  _minSeq() {
    let min = null;
    for (const k of this._frames.keys()) {
      const b = BigInt(k);
      if (min === null || b < min) min = b;
    }
    return min;
  }

  _silence() {
    return new Int16Array(this._frameSamples);
  }

  // Drop everything still queued (used on hangup).
  stop() {
    this._frames.clear();
  }
}

module.exports = JitterBuffer;
