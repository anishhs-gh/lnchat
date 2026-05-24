'use strict';

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const dgram   = require('dgram');
const os      = require('os');
const path    = require('path');
const PeerStore   = require('../src/peer/peerStore');
const KnownPeers  = require('../src/utils/knownPeers');
const Listener    = require('../src/discovery/listener');
const Broadcaster = require('../src/discovery/broadcaster');
const testCreds   = require('./testCreds');

// Send a UDP packet to the given port on loopback
function sendUDP(payload, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const buf  = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    sock.send(buf, 0, buf.length, port, '127.0.0.1', (err) => {
      sock.close();
      err ? reject(err) : resolve();
    });
  });
}

// Create a temp-file KnownPeers instance for test isolation
function tmpKnownPeers() {
  return new KnownPeers(path.join(os.tmpdir(), `lnchat-test-peers-${Date.now()}-${Math.random()}.json`));
}

async function startListener(deviceId, store, knownPeers = null, space = '') {
  const listener = new Listener(deviceId, store, knownPeers, space);
  await listener.start();
  return listener;
}

// { concurrency: 1 } prevents tests from running in parallel within this suite.
// Without it, multiple tests all race to bind port 41234 simultaneously — the winner
// gets it, the others fall back to 41235, 41236, … and sendUDP (which targets the
// listener's actual boundPort) still works, but the "two instances" test needs two
// ports simultaneously, so serialising is the safe choice.
describe('Discovery', { concurrency: 1 }, () => {
  test('listener updates peerStore when it receives a valid HELLO', async () => {
    const store  = new PeerStore();
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    const listener = await startListener('device-B', store);

    await sendUDP(
      { type: 'HELLO', id: 'device-A', nickname: 'Alice', port: 9001, timestamp: Date.now() },
      listener.boundPort
    );
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    assert.ok(joined.some((p) => p.nickname === 'Alice'), 'Alice should have joined');
  });

  test('listener stores the correct port for the discovered peer', async () => {
    const store    = new PeerStore();
    const listener = await startListener('device-B2', store);

    await sendUDP(
      { type: 'HELLO', id: 'device-A2', nickname: 'Carol', port: 8765, timestamp: Date.now() },
      listener.boundPort
    );
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();

    const carol = store.list().find((p) => p.nickname === 'Carol');
    assert.ok(carol, 'Carol should be in the peer list');
    assert.equal(carol.port, 8765);
    store.destroy();
  });

  test('listener ignores packets from its own device id', async () => {
    const SELF   = 'same-id';
    const store  = new PeerStore();
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    const listener = await startListener(SELF, store);

    await sendUDP(
      { type: 'HELLO', id: SELF, nickname: 'Self', port: 9002, timestamp: Date.now() },
      listener.boundPort
    );
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    // Only assert that the self-peer was not added — other HELLOs (e.g. from a
    // running lnchat instance on the same machine) may arrive on the same port.
    assert.ok(!joined.some(p => p.id === SELF), 'should not discover itself');
  });

  test('listener silently discards malformed UDP packets', async () => {
    const store    = new PeerStore();
    const listener = await startListener('device-X', store);

    // Drain any background HELLOs from other lnchat instances before tracking.
    await new Promise((r) => setTimeout(r, 150));
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    await sendUDP('{bad json!!}', listener.boundPort);
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    assert.equal(joined.length, 0, 'malformed packet should add no peer');
  });

  test('listener discards a valid-JSON packet with a non-HELLO type', async () => {
    const store    = new PeerStore();
    const listener = await startListener('device-Y', store);

    await sendUDP(
      { type: 'UNKNOWN', id: 'z', nickname: 'Ghost', port: 9003 },
      listener.boundPort
    );
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    // Only assert our specific test peer was not added — background lnchat
    // HELLOs on the same port range must not cause false failures.
    assert.ok(!store.list().some(p => p.id === 'z'), 'non-HELLO packet should not add peers');
  });

  test('listener discards a HELLO with missing required fields', async () => {
    const store    = new PeerStore();
    const listener = await startListener('device-Z', store);

    await sendUDP(
      { type: 'HELLO', id: 'device-W' }, // missing nickname and port
      listener.boundPort
    );
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    assert.equal(store.list().length, 0);
  });

  test('broadcaster sends a parseable HELLO that the listener receives', async () => {
    const store    = new PeerStore();
    const received = [];
    store.onJoin = (p) => received.push(p);

    // Use a Listener so the broadcaster naturally sends to its boundPort
    const listener    = await startListener('recv-device', store);
    const broadcaster = new Broadcaster('bcast-test', 'TestNode', 'ab12', 7777, null);
    broadcaster.start();

    await new Promise((r) => setTimeout(r, 200));

    broadcaster.stop();
    listener.stop();
    store.destroy();

    // onJoin only passes { id, nickname } — verify port via the store
    assert.ok(received.some((p) => p.nickname === 'TestNode'), 'TestNode should have been discovered');
    const peer = store.list().find((p) => p.nickname === 'TestNode');
    assert.ok(peer, 'TestNode should be in the peer list');
    assert.equal(peer.port, 7777);
  });

  test('listener accepts a correctly signed HELLO', async () => {
    const { signingKey, signingPublicKeyB64, signHello } = testCreds;

    const store = new PeerStore();
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    const knownPeers = tmpKnownPeers();
    const listener   = await startListener('recv-signed', store, knownPeers);

    const timestamp = Date.now();
    const fields = {
      discriminator: 'aa11',
      fingerprint:   null,
      id:            'signed-a',
      nickname:      'SignedAlice',
      port:          9300,
      publicKey:     signingPublicKeyB64,
      space:         '',
      timestamp,
    };
    const signature = signHello(fields);

    await sendUDP({ type: 'HELLO', ...fields, signature }, listener.boundPort);
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    assert.ok(joined.some((p) => p.nickname === 'SignedAlice'), 'correctly signed HELLO should be accepted');
  });

  test('listener rejects a HELLO with a forged signature', async () => {
    const { signingPublicKeyB64 } = testCreds;

    const store = new PeerStore();
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    const listener = await startListener('recv-forged', store, null);

    await sendUDP(
      {
        type:          'HELLO',
        id:            'forger-x',
        nickname:      'Forger',
        discriminator: 'aaaa',
        port:          9301,
        fingerprint:   null,
        publicKey:     signingPublicKeyB64,
        timestamp:     Date.now(),
        // 88-byte base64 is the right length for an Ed25519 sig but the content is bogus
        signature:     Buffer.alloc(64).toString('base64'),
      },
      listener.boundPort
    );
    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    assert.ok(!joined.some((p) => p.id === 'forger-x'), 'forged signature should be rejected');
  });

  test('listener ignores HELLOs from a different space', async () => {
    const store  = new PeerStore();
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    // Listener is in space 'team-alpha'
    const listener = await startListener('space-host-id', store, null, 'team-alpha');

    // Default space '' — should be filtered out
    await sendUDP(
      { type: 'HELLO', id: 'space-peer-1', nickname: 'Outsider', port: 9400, space: '', timestamp: Date.now() },
      listener.boundPort
    );
    // Wrong named space — should be filtered out
    await sendUDP(
      { type: 'HELLO', id: 'space-peer-2', nickname: 'WrongSpace', port: 9401, space: 'team-beta', timestamp: Date.now() },
      listener.boundPort
    );
    // Same space — should be accepted
    await sendUDP(
      { type: 'HELLO', id: 'space-peer-3', nickname: 'SameSpace', port: 9402, space: 'team-alpha', timestamp: Date.now() },
      listener.boundPort
    );

    await new Promise((r) => setTimeout(r, 100));

    listener.stop();
    store.destroy();

    assert.ok(!joined.some((p) => p.id === 'space-peer-1'), 'default-space peer should be ignored');
    assert.ok(!joined.some((p) => p.id === 'space-peer-2'), 'wrong-space peer should be ignored');
    assert.ok(joined.some((p) => p.id === 'space-peer-3'),  'same-space peer should be discovered');
  });

  test('two instances on same machine discover each other', async () => {
    const storeA = new PeerStore(), storeB = new PeerStore();
    const joinedA = [], joinedB = [];
    storeA.onJoin = (p) => joinedA.push(p);
    storeB.onJoin = (p) => joinedB.push(p);

    // Each listener claims its own port; broadcasters send to all ports in range
    const listenerA = await startListener('id-A', storeA);
    const listenerB = await startListener('id-B', storeB);

    const bcA = new Broadcaster('id-A', 'NodeA', 'aa11', 9100, null);
    const bcB = new Broadcaster('id-B', 'NodeB', 'bb22', 9101, null);
    bcA.start();
    bcB.start();

    await new Promise((r) => setTimeout(r, 500));

    bcA.stop(); bcB.stop();
    listenerA.stop(); listenerB.stop();
    storeA.destroy(); storeB.destroy();

    assert.ok(joinedA.some((p) => p.nickname === 'NodeB'), 'A should see B');
    assert.ok(joinedB.some((p) => p.nickname === 'NodeA'), 'B should see A');
  });
});
