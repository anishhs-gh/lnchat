'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const JitterBuffer = require('../src/voice/jitterBuffer');

// Small frames keyed by their first sample value, so emitted order is easy to read.
const frame = (id) => Int16Array.from([id, id, id]);
const idOf  = (f)  => f[0];

function collectInto(arr, opts) {
  return new JitterBuffer((f) => arr.push(f), Object.assign({ frameSamples: 3 }, opts));
}

describe('JitterBuffer', () => {
  test('prebuffers, then emits in order', () => {
    const out = [];
    const jb = collectInto(out, { target: 2 });

    jb.push(0n, frame(0));
    assert.equal(out.length, 0); // still prebuffering (only 1 < target 2)
    jb.push(1n, frame(1));
    assert.deepEqual(out.map(idOf), [0, 1]); // target reached → flush
    jb.push(2n, frame(2));
    assert.deepEqual(out.map(idOf), [0, 1, 2]);
  });

  test('reorders an out-of-order arrival', () => {
    const out = [];
    const jb = collectInto(out, { target: 2 });

    jb.push(0n, frame(0));
    jb.push(2n, frame(2));            // arrives before 1
    assert.deepEqual(out.map(idOf), [0]); // 0 emitted, waiting on 1
    jb.push(1n, frame(1));
    assert.deepEqual(out.map(idOf), [0, 1, 2]);
  });

  test('conceals a lost packet with silence once the backlog exceeds max', () => {
    const out = [];
    const jb = collectInto(out, { target: 2, max: 3 });

    jb.push(0n, frame(0));
    jb.push(1n, frame(1));            // → emits 0,1 ; next = 2
    // seq 2 and 3 are "lost"; later frames pile up past max (3)
    jb.push(4n, frame(4));
    jb.push(5n, frame(5));
    jb.push(6n, frame(6));
    jb.push(7n, frame(7));           // backlog now {4,5,6,7} = 4 > max 3 → conceal 2 & 3

    const ids = out.map(idOf);
    assert.deepEqual(ids.slice(0, 2), [0, 1]);
    assert.equal(jb.concealed, 2);                 // two silence frames for seq 2,3
    assert.deepEqual(ids.slice(-4), [4, 5, 6, 7]); // then real audio resumes
    // the two concealed frames are silence
    const silentCount = out.filter((f) => idOf(f) === 0 && f !== out[0]).length;
    assert.ok(silentCount >= 2);
  });

  test('drops a frame that arrives after its slot already played', () => {
    const out = [];
    const jb = collectInto(out, { target: 1 });

    jb.push(5n, frame(5));   // starts, next = 5, emits 5 → next = 6
    jb.push(4n, frame(4));   // 4 < 6 → too late, dropped
    assert.deepEqual(out.map(idOf), [5]);
  });
});
