'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const MediaSocket = require('../src/voice/mediaSocket');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Wire two media sockets to each other on loopback with a shared key.
async function pair(keyA, keyB) {
  const a = new MediaSocket(keyA, 0); // caller
  const b = new MediaSocket(keyB, 1); // callee
  const portA = await a.bind();
  const portB = await b.bind();
  a.setRemote('127.0.0.1', portB);
  b.setRemote('127.0.0.1', portA);
  return { a, b };
}

describe('MediaSocket', () => {
  let sockets = [];
  function track(p) { sockets.push(p.a, p.b); return p; }
  afterEach(() => { sockets.forEach((s) => s.close()); sockets = []; });

  test('encrypts, sends, and decrypts a PCM frame intact', async () => {
    const key = crypto.randomBytes(32);
    const { a, b } = track(await pair(key, key));

    const received = [];
    b.on('frame', (samples) => received.push(samples));

    const frame = Int16Array.from([0, 1000, -1000, 32767, -32768, 42]);
    a.send(frame);
    await wait(50);

    assert.equal(received.length, 1);
    assert.deepEqual(Array.from(received[0]), Array.from(frame));
    assert.equal(b.framesRecv, 1);
  });

  test('both directions stream independently over one key', async () => {
    const key = crypto.randomBytes(32);
    const { a, b } = track(await pair(key, key));

    const gotA = [];
    const gotB = [];
    a.on('frame', (s) => gotA.push(s));
    b.on('frame', (s) => gotB.push(s));

    a.send(Int16Array.from([1, 2, 3]));
    b.send(Int16Array.from([4, 5, 6]));
    await wait(50);

    assert.deepEqual(Array.from(gotB[0]), [1, 2, 3]); // caller → callee
    assert.deepEqual(Array.from(gotA[0]), [4, 5, 6]); // callee → caller
  });

  test('rejects frames encrypted under a different key', async () => {
    const { a, b } = track(await pair(crypto.randomBytes(32), crypto.randomBytes(32)));

    let frames = 0;
    b.on('frame', () => frames++);
    a.send(Int16Array.from([1, 2, 3, 4]));
    await wait(50);

    assert.equal(frames, 0);      // authentication fails → frame dropped
    assert.equal(b.framesRecv, 0);
  });

  test('drops a tampered packet without emitting', async () => {
    const key = crypto.randomBytes(32);
    const { a, b } = track(await pair(key, key));

    // Reach into the send path to flip a ciphertext byte before it goes out.
    const realSend = a._socket.send.bind(a._socket);
    a._socket.send = (buf, port, ip, cb) => {
      buf[buf.length - 17] ^= 0xff; // corrupt the last ciphertext byte (before the 16-byte tag)
      return realSend(buf, port, ip, cb);
    };

    let frames = 0;
    b.on('frame', () => frames++);
    a.send(Int16Array.from([7, 8, 9, 10]));
    await wait(50);

    assert.equal(frames, 0);
  });
});
