'use strict';

// Minimal iterative radix-2 FFT used by the echo canceller. Size must be a power
// of two. Twiddle factors and the bit-reversal permutation are precomputed once
// per size, so transform() is allocation-free on the hot path.
//
// transform() operates in place on separate real/imag Float64Arrays. inverse()
// includes the 1/n scaling so that inverse(forward(x)) === x.
class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;

    // Bit-reversal permutation indices.
    this._rev = new Uint32Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      this._rev[i] = j;
    }

    // Twiddle table: cos/sin(-2π k / n) for k in [0, n).
    this._cos = new Float64Array(n);
    this._sin = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      this._cos[k] = Math.cos((-2 * Math.PI * k) / n);
      this._sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
  }

  _run(re, im, inverse) {
    const n = this.n, rev = this._rev, cos = this._cos, sin = this._sin;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len; // twiddle stride for this stage
      for (let i = 0; i < n; i += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          let wr = cos[t], wi = sin[t];
          if (inverse) wi = -wi; // conjugate twiddles for the inverse transform
          const a = i + k, b = a + half;
          const xr = re[b], xi = im[b];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr;        im[a] += ti;
        }
      }
    }
  }

  forward(re, im) { this._run(re, im, false); }

  inverse(re, im) {
    this._run(re, im, true);
    const n = this.n;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

module.exports = FFT;
