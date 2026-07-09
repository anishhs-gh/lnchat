'use strict';

const FFT = require('./fft');

// Acoustic echo canceller — removes the far-end voice that leaks from your
// speaker back into your microphone, so callers can talk WITHOUT headphones
// without echoing themselves back to the other side.
//
// Algorithm: a partitioned-block frequency-domain adaptive filter (overlap-save
// NLMS), the standard efficient AEC structure (this is the family SpeexDSP and
// WebRTC use). Pure JS, no native code, cross-platform.
//
//   reference x = what we just played to the speaker (the remote audio)
//   microphone d = our voice + the echo of x bouncing around the room
//   the adaptive filter learns the room's echo path and predicts the echo ŷ,
//   then outputs e = d − ŷ ≈ our voice alone.
//
// Two extra stages make it usable in the real world:
//   • Double-talk freeze: when YOU are speaking (near-end energy dominates), the
//     filter stops adapting so it doesn't diverge — your speech passes through.
//   • Residual suppressor: a spectral post-gain attenuates whatever echo the
//     linear filter couldn't model (non-linear speaker distortion, etc.).
//
// Block math: R = 512-sample hop, N = 1024-point FFT (50% overlap-save), P
// partitions → models an echo tail of P·R/48000 ≈ 128 ms, which covers typical
// room reflections plus device output buffering. Frames handed in (480 samples)
// are re-blocked internally; the canceller adds ~one block (~10 ms) of latency.
class EchoCanceller {
  constructor(opts = {}) {
    this.R    = opts.blockSize  || 512;
    this.N    = this.R * 2;                  // FFT size (power of two)
    this.P    = opts.partitions || 12;       // tail = P·R samples
    this.mu   = opts.mu != null ? opts.mu : 0.3;   // NLMS step size
    this.delta = opts.delta != null ? opts.delta : 1e-2; // power regularization
    this.resBeta = opts.residual != null ? opts.residual : 1.0; // residual suppress strength
    this.gMin = opts.gMin != null ? opts.gMin : 0.08;           // max residual attenuation

    this._fft = new FFT(this.N);
    this.reset();

    // Reusable scratch buffers (allocation-free hot path).
    this._re = new Float64Array(this.N);
    this._im = new Float64Array(this.N);
    this._yr = new Float64Array(this.N);
    this._yi = new Float64Array(this.N);
    this._er = new Float64Array(this.N);
    this._ei = new Float64Array(this.N);
    this._pbin = new Float64Array(this.N); // per-bin reference power for NLMS
  }

  reset() {
    const N = this.N, P = this.P, R = this.R;
    // Filter partitions (frequency domain) and reference-spectrum history.
    this._Wr = Array.from({ length: P }, () => new Float64Array(N));
    this._Wi = Array.from({ length: P }, () => new Float64Array(N));
    this._Xr = Array.from({ length: P }, () => new Float64Array(N));
    this._Xi = Array.from({ length: P }, () => new Float64Array(N));
    this._prevRef = new Float64Array(R);
    this._dtd = 1; // smoothed double-talk gain (1 = adapt freely, 0 = frozen)

    // Sample queues (float, [-1,1]); output is primed with one block of silence
    // so process() can always return a full frame (introduces the ~one-block delay).
    this._micQ = [];
    this._refQ = [];
    this._outQ = new Array(R).fill(0);
  }

  // mic, ref: Int16Array frames of equal length. Returns an Int16Array of the
  // same length: the microphone with the speaker echo removed.
  process(mic, ref) {
    const n = mic.length;
    const rn = ref ? ref.length : 0;
    for (let i = 0; i < n; i++) {
      this._micQ.push(mic[i] / 32768);
      this._refQ.push((i < rn ? ref[i] : 0) / 32768);
    }
    while (this._micQ.length >= this.R && this._refQ.length >= this.R) {
      this._processBlock(this._micQ.splice(0, this.R), this._refQ.splice(0, this.R));
    }
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = this._outQ.shift();
      const v = Math.round((s || 0) * 32768);
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return out;
  }

  _processBlock(d, x) {
    const N = this.N, R = this.R, P = this.P;
    const re = this._re, im = this._im;

    // 1. FFT of the reference window [prevRef | curRef]  → push to history.
    for (let i = 0; i < R; i++) { re[i] = this._prevRef[i]; im[i] = 0; }
    for (let i = 0; i < R; i++) { re[R + i] = x[i]; im[R + i] = 0; }
    this._prevRef.set(x);
    this._fft.forward(re, im);
    // rotate history: reuse the oldest buffers as the newest
    const Xr = this._Xr.pop(); const Xi = this._Xi.pop();
    Xr.set(re); Xi.set(im);
    this._Xr.unshift(Xr); this._Xi.unshift(Xi);

    // 2. Estimated echo spectrum  Y = Σ_p W_p · X_p   (complex), and the per-bin
    //    reference power  Pbin[k] = Σ_p |X_p[k]|²  used to normalize the NLMS step.
    const yr = this._yr, yi = this._yi, pbin = this._pbin;
    yr.fill(0); yi.fill(0); pbin.fill(0);
    for (let p = 0; p < P; p++) {
      const wr = this._Wr[p], wi = this._Wi[p], xr = this._Xr[p], xi = this._Xi[p];
      for (let k = 0; k < N; k++) {
        yr[k] += wr[k] * xr[k] - wi[k] * xi[k];
        yi[k] += wr[k] * xi[k] + wi[k] * xr[k];
        pbin[k] += xr[k] * xr[k] + xi[k] * xi[k];
      }
    }

    // 3. echo (time) = last R samples of IFFT(Y)
    this._fft.inverse(yr, yi);
    let micEnergy = 0, errEnergy = 0;
    const e = new Float64Array(R);
    for (let i = 0; i < R; i++) {
      const echo = yr[R + i];
      e[i] = d[i] - echo;
      micEnergy += d[i] * d[i];
      errEnergy += e[i] * e[i];
    }

    // 4. Adaptation control (double-talk / divergence guard): adapt fully when the
    // filter is clearly reducing the mic energy (error ≪ mic); slow down when the
    // error is as large as the mic — that's either the not-yet-converged start or
    // near-end speech, and in both cases we don't want to yank the filter around.
    // Crucially this still allows convergence (gain floored at 0.1), unlike a gate
    // keyed on the estimated-echo energy, which is ~0 before the filter has learnt.
    const ratio  = errEnergy / (micEnergy + 1e-6);
    const target = Math.max(0.1, Math.min(1, 1.3 - ratio));
    this._dtd = 0.7 * this._dtd + 0.3 * target;

    // 5. NLMS update (unconstrained): W_p += μ·dtd · conj(X_p)·E / power
    const er = this._er, ei = this._ei;
    er.fill(0); ei.fill(0);
    for (let i = 0; i < R; i++) er[R + i] = e[i]; // error in the second half
    this._fft.forward(er, ei);

    const muStep = this.mu * this._dtd;
    if (muStep > 0) {
      const pbin = this._pbin, delta = this.delta;
      for (let p = 0; p < P; p++) {
        const wr = this._Wr[p], wi = this._Wi[p], xr = this._Xr[p], xi = this._Xi[p];
        for (let k = 0; k < N; k++) {
          const muN = muStep / (pbin[k] + delta); // per-bin normalized step (NLMS)
          // conj(X)·E = (xr - i·xi)(er + i·ei)
          wr[k] += muN * (xr[k] * er[k] + xi[k] * ei[k]);
          wi[k] += muN * (xr[k] * ei[k] - xi[k] * er[k]);
        }
      }
    }

    // 6. Residual echo suppression (spectral gain) + emit the cleaned block.
    this._suppressAndEmit(er, ei);
  }

  // Apply the residual-suppression gain to the error spectrum, then IFFT and emit
  // the R cleaned samples. The gain is Wiener-style: bins where the estimated echo
  // still dominates the cleaned signal are attenuated (down to gMin).
  _suppressAndEmit(er, ei) {
    const N = this.N, R = this.R;

    // Echo estimate is in this._yr (time domain, 2nd half) from step 3; transform
    // it back to the frequency domain — laid out like the error — for the gain.
    const re = this._re, im = this._im, echoTime = this._yr;
    re.fill(0); im.fill(0);
    for (let i = 0; i < R; i++) re[R + i] = echoTime[R + i];
    this._fft.forward(re, im);

    for (let k = 0; k < N; k++) {
      const eMag = er[k] * er[k] + ei[k] * ei[k] + 1e-9;
      const yMag = re[k] * re[k] + im[k] * im[k];
      let g = eMag / (eMag + this.resBeta * yMag);
      if (g < this.gMin) g = this.gMin;
      er[k] *= g; ei[k] *= g;
    }

    this._fft.inverse(er, ei);
    for (let i = 0; i < R; i++) this._outQ.push(er[R + i]);
  }
}

module.exports = EchoCanceller;
