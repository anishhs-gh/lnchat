'use strict';

const events = require('events');
const JitterBuffer = require('./jitterBuffer');
const { SAMPLE_RATE, FRAME_SAMPLES, FRAME_BYTES } = require('./audioFormat');

// ── Audio format (cross-platform) ────────────────────────────────────────────
// 48 kHz / 16-bit / mono (see audioFormat.js). PortAudio (which naudiodon2 wraps)
// presents the same API on CoreAudio (macOS), WASAPI (Windows), and ALSA (Linux),
// so none of the code below is OS-specific. deviceId -1 = the system default
// device everywhere, so we never assume a particular device name, index, or count.

// naudiodon2 is an OPTIONAL native dependency. It is loaded lazily and only when
// a call actually starts, so:
//   • importing this module never pulls in native code,
//   • the rest of lnchat (chat, file transfer) runs on every platform even when
//     the native module is missing, failed to build, or has no prebuilt binary.
let _na;            // cached module once loaded
let _loadError;     // cached failure reason
function loadNaudiodon() {
  if (_na) return _na;
  if (_loadError) throw _loadError;
  try {
    _na = require('naudiodon2');
    return _na;
  } catch (e) {
    _loadError = e;
    throw e;
  }
}

// True if the native audio backend can be loaded on this system. Never throws —
// callers use it to decide whether voice is available before starting a call.
function isAudioAvailable() {
  try { loadNaudiodon(); return true; } catch (_) { return false; }
}

// One-line reason voice is unavailable (for a helpful message), or null.
function audioUnavailableReason() {
  try { loadNaudiodon(); return null; } catch (e) { return e.message; }
}

function ioOptions(extra) {
  return Object.assign({
    channelCount: 1,
    sampleFormat: loadNaudiodon().SampleFormat16Bit,
    sampleRate:   SAMPLE_RATE,
    deviceId:     -1,     // system default device on every platform
    closeOnError: true,
  }, extra);
}

// ── Microphone capture ───────────────────────────────────────────────────────
// Reads default-device PCM and re-chunks it into exact 20 ms frames, emitting
// 'frame' (Int16Array of 960 samples). Same interface as ToneSource, so it drops
// into CallManager unchanged. Emits 'error' if the device fails to open/read.
class MicSource extends events.EventEmitter {
  constructor() {
    super();
    this._io  = null;
    this._buf = Buffer.alloc(0);
  }

  start() {
    const na = loadNaudiodon();
    this._io = new na.AudioIO({ inOptions: ioOptions({ framesPerBuffer: FRAME_SAMPLES }) });
    this._io.on('data',  (chunk) => this._onData(chunk));
    this._io.on('error', (err)   => this.emit('error', err));
    this._io.start();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this._buf.length >= FRAME_BYTES) {
      // Copy into an aligned buffer so the Int16Array view is always valid.
      const frame = Buffer.from(this._buf.subarray(0, FRAME_BYTES));
      this._buf   = this._buf.subarray(FRAME_BYTES);
      this.emit('frame', new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES));
    }
  }

  stop() {
    if (this._io) {
      try { this._io.quit(); } catch (_) {}
      this._io = null;
    }
    this._buf = Buffer.alloc(0);
    this.removeAllListeners();
  }
}

// ── Speaker playback ─────────────────────────────────────────────────────────
// Feeds a JitterBuffer; the buffer emits clean in-order frames that we write to
// the default output device. onError is invoked if the device fails.
class Speaker {
  constructor() {
    this._io      = null;
    this._jitter  = null;
    this.onError  = null;
    this.onPlay   = null; // invoked with each frame actually played (the AEC reference)
  }

  start() {
    const na = loadNaudiodon();
    this._io = new na.AudioIO({ outOptions: ioOptions({}) });
    this._io.on('error', (err) => { if (this.onError) this.onError(err); });
    this._io.start();
    this._jitter = new JitterBuffer((samples) => this._write(samples), { frameSamples: FRAME_SAMPLES });
  }

  // Queue a decrypted remote frame for playout (seq is a BigInt from MediaSocket).
  play(seq, samples) {
    if (this._jitter) this._jitter.push(seq, samples);
  }

  _write(samples) {
    if (!this._io) return;
    // The exact samples we play are the echo canceller's reference signal.
    if (this.onPlay) this.onPlay(samples);
    try {
      this._io.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    } catch (_) { /* output closed mid-write */ }
  }

  stop() {
    if (this._jitter) { this._jitter.stop(); this._jitter = null; }
    if (this._io) {
      try { this._io.quit(); } catch (_) {}
      this._io = null;
    }
  }
}

module.exports = {
  MicSource,
  Speaker,
  isAudioAvailable,
  audioUnavailableReason,
  SAMPLE_RATE,
  FRAME_SAMPLES,
};
