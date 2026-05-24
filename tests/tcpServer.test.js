'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('tls');
const TCPServer = require('../src/messaging/tcpServer');
const { sendMessage, sendPing } = require('../src/messaging/tcpClient');
const testCreds = require('./testCreds');

describe('TCPServer', () => {
  test('receives MESSAGE and calls onMessage callback', async () => {
    const messages = [];
    const server = new TCPServer(0, (msg) => messages.push(msg), testCreds);
    const port = await server.start();

    await sendMessage('127.0.0.1', port, {
      type: 'MESSAGE',
      from: { id: 'x', nickname: 'Bob' },
      message: 'hello world',
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, 'hello world');
    assert.equal(messages[0].from.nickname, 'Bob');
    server.stop();
  });

  test('responds to PING with measurable RTT', async () => {
    const server = new TCPServer(0, () => {}, testCreds);
    const port = await server.start();

    const ms = await sendPing('127.0.0.1', port);
    assert.ok(typeof ms === 'number');
    assert.ok(ms >= 0 && ms < 2000);
    server.stop();
  });

  test('ignores malformed JSON without crashing', async () => {
    const server = new TCPServer(0, () => {}, testCreds);
    const port = await server.start();

    // Send garbage over a TLS connection — server should discard and stay alive
    await new Promise((resolve, reject) => {
      const sock = tls.connect(
        { host: '127.0.0.1', port, rejectUnauthorized: false, checkServerIdentity: () => undefined },
        () => {
          sock.write('totally}{not json\n');
          sock.end();
        }
      );
      sock.on('close', resolve);
      sock.on('error', reject);
    });

    // Server should still be responsive
    const ms = await sendPing('127.0.0.1', port);
    assert.ok(ms >= 0);
    server.stop();
  });

  test('falls back to a random port when preferred port is already bound', async () => {
    const server1 = new TCPServer(0, () => {}, testCreds);
    const port1 = await server1.start();

    const server2 = new TCPServer(port1, () => {}, testCreds);
    const port2 = await server2.start();

    assert.notEqual(port1, port2);
    assert.ok(port2 > 0);

    server1.stop();
    server2.stop();
  });

  test('handles multiple concurrent messages', async () => {
    const messages = [];
    const server = new TCPServer(0, (msg) => messages.push(msg), testCreds);
    const port = await server.start();

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sendMessage('127.0.0.1', port, {
          type: 'MESSAGE',
          from: { id: `p${i}`, nickname: `Peer${i}` },
          message: `msg${i}`,
        })
      )
    );

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(messages.length, 5);
    server.stop();
  });

  test('MESSAGE missing required fields does not crash', async () => {
    const messages = [];
    const server = new TCPServer(0, (msg) => messages.push(msg), testCreds);
    const port = await server.start();

    // Sends a MESSAGE without the expected shape — should be silently ignored
    await sendMessage('127.0.0.1', port, { type: 'MESSAGE' });

    await new Promise((r) => setTimeout(r, 50));
    // Still called — we don't filter at the server level, caller handles shape
    const ms = await sendPing('127.0.0.1', port);
    assert.ok(ms >= 0);
    server.stop();
  });
});
