'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const tls    = require('tls');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const FileDataServer = require('../src/messaging/fileDataServer');
const testCreds      = require('./testCreds');

// Helper: connect as a TLS client to the data server, collect all bytes, return Buffer
function collectBytes(port) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock   = tls.connect(
      { host: '127.0.0.1', port, rejectUnauthorized: false, checkServerIdentity: () => undefined },
      () => {}
    );
    sock.on('data',  (c) => chunks.push(c));
    sock.on('end',   ()  => resolve(Buffer.concat(chunks)));
    sock.on('error', reject);
  });
}

// Write a temp file with given content, return its path
function tmpFile(content) {
  const p = path.join(os.tmpdir(), `lnchat-fds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, content);
  return p;
}

describe('FileDataServer', () => {
  test('resolves port before any client connects', async () => {
    const srv  = new FileDataServer(testCreds.cert, testCreds.key);
    const tmp  = tmpFile('hello');
    const port = await srv.start(tmp, 0, 5000);
    assert.ok(typeof port === 'number' && port > 0);
    srv.cancel();
    fs.unlinkSync(tmp);
  });

  test('streams the full file to the connecting client', async () => {
    const content = 'hello world from file data server';
    const tmp     = tmpFile(content);
    const srv     = new FileDataServer(testCreds.cert, testCreds.key);
    const port    = await srv.start(tmp, 0, 5000);

    // Register 'done' listener BEFORE client connects to avoid race
    const doneP   = new Promise((r) => srv.once('done', r));
    const received = await collectBytes(port);
    await doneP;

    assert.equal(received.toString(), content);
    fs.unlinkSync(tmp);
  });

  test('streams from a byte offset (resume support)', async () => {
    const tmp  = tmpFile('ABCDEFGHIJ');
    const srv  = new FileDataServer(testCreds.cert, testCreds.key);
    const port = await srv.start(tmp, 4, 5000); // start from byte 4 → "EFGHIJ"

    const doneP    = new Promise((r) => srv.once('done', r));
    const received = await collectBytes(port);
    await doneP;

    assert.equal(received.toString(), 'EFGHIJ');
    fs.unlinkSync(tmp);
  });

  test('emits progress events with correct byte counts', async () => {
    const content = Buffer.alloc(64 * 1024, 0x42); // 64 KB
    const tmp     = tmpFile(content);
    const srv     = new FileDataServer(testCreds.cert, testCreds.key);
    const events  = [];

    srv.on('progress', (sent, total) => events.push({ sent, total }));
    const port  = await srv.start(tmp, 0, 5000);
    const doneP = new Promise((r) => srv.once('done', r));
    await collectBytes(port);
    await doneP;

    assert.ok(events.length > 0, 'at least one progress event');
    const last = events[events.length - 1];
    assert.equal(last.sent, content.length);
    assert.equal(last.total, content.length);
    fs.unlinkSync(tmp);
  });

  test('emits error and rejects start() on accept timeout', async () => {
    const tmp = tmpFile('data');
    const srv = new FileDataServer(testCreds.cert, testCreds.key);

    let errorFired = false;
    srv.on('error', () => { errorFired = true; });

    await srv.start(tmp, 0, 100); // 100ms timeout — no client will connect
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(errorFired);
    fs.unlinkSync(tmp);
  });

  test('cancel() stops the server cleanly', async () => {
    const tmp  = tmpFile('data');
    const srv  = new FileDataServer(testCreds.cert, testCreds.key);
    const port = await srv.start(tmp, 0, 5000);
    srv.cancel();

    // Port should be closed — connecting should fail
    await assert.rejects(collectBytes(port));
    fs.unlinkSync(tmp);
  });
});
