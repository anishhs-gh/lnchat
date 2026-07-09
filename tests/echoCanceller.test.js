'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const FFT = require('../src/voice/fft');
const EchoCanceller = require('../src/voice/echoCanceller');

describe('FFT', () => {
  test('inverse(forward(x)) round-trips', () => {
    const n = 8;
    const re = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const im = new Float64Array(n);
    const re0 = Float64Array.from(re);
    const fft = new FFT(n);
    fft.forward(re, im);
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - re0[i]) < 1e-9);
  });

  test('FFT of a constant is a DC impulse', () => {
    const n = 8;
    const re = new Float64Array(n).fill(1);
    const im = new Float64Array(n);
    new FFT(n).forward(re, im);
    assert.ok(Math.abs(re[0] - n) < 1e-9); // all energy at bin 0
    for (let k = 1; k < n; k++) assert.ok(Math.abs(re[k]) < 1e-9 && Math.abs(im[k]) < 1e-9);
  });

  test('rejects non-power-of-two sizes', () => {
    assert.throws(() => new FFT(960));
  });
});

// Deterministic pseudo-random reference in [-0.25, 0.25] of full scale.
function makeRef(total, seed = 12345) {
  let s = seed >>> 0;
  const x = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    s = (1103515245 * s + 12345) >>> 0;
    x[i] = Math.round(((s / 0xffffffff) * 2 - 1) * 8000);
  }
  return x;
}

const energy = (a, from = 0, to = a.length) => {
  let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i]; return e;
};

describe('EchoCanceller', () => {
  test('cancels a synthetic linear echo (positive ERLE after convergence)', () => {
    const FRAME = 480, frames = 300, total = FRAME * frames, delay = 256, gain = 0.6;
    const x = makeRef(total);

    // mic = echo only (no near-end speech): a scaled, delayed copy of the reference.
    const mic = new Int16Array(total);
    for (let n = 0; n < total; n++) mic[n] = n >= delay ? Math.round(gain * x[n - delay]) : 0;

    const aec = new EchoCanceller();
    const out = new Int16Array(total);
    for (let f = 0; f < frames; f++) {
      const off = f * FRAME;
      const cleaned = aec.process(mic.subarray(off, off + FRAME), x.subarray(off, off + FRAME));
      out.set(cleaned, off);
    }

    // Measure on the converged tail (last 60 frames).
    const tailFrom = total - 60 * FRAME;
    const micE = energy(mic, tailFrom);
    const outE = energy(out, tailFrom);
    const erle = 10 * Math.log10(micE / (outE + 1));
    assert.ok(erle > 10, `expected >10 dB echo reduction, got ${erle.toFixed(1)} dB`);
  });

  test('preserves near-end audio when there is no echo (reference silent)', () => {
    const FRAME = 480, frames = 120, total = FRAME * frames;
    const near = makeRef(total, 777);          // near-end "voice"
    const silentRef = new Int16Array(FRAME);   // nothing playing on the speaker

    const aec = new EchoCanceller();
    const out = new Int16Array(total);
    for (let f = 0; f < frames; f++) {
      const off = f * FRAME;
      out.set(aec.process(near.subarray(off, off + FRAME), silentRef), off);
    }

    // With no reference the canceller must not eat the near-end signal.
    const tailFrom = total - 60 * FRAME;
    const ratio = energy(out, tailFrom) / energy(near, tailFrom);
    assert.ok(ratio > 0.8, `near-end energy should be preserved, ratio=${ratio.toFixed(2)}`);
  });
});
