'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const PeerStore = require('../src/peer/peerStore');

describe('PeerStore', () => {
  let store;

  afterEach(() => { if (store) store.destroy(); });

  test('adds new peer and fires onJoin', () => {
    store = new PeerStore();
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);

    assert.equal(joined.length, 1);
    assert.equal(joined[0].nickname, 'Alice');
    assert.equal(store.list().length, 1);
  });

  test('refreshing an existing peer does not fire onJoin again', () => {
    store = new PeerStore();
    const joined = [];
    store.onJoin = (p) => joined.push(p);

    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);

    assert.equal(joined.length, 1);
    assert.equal(store.list().length, 1);
  });

  test('remove fires onLeave and removes peer', () => {
    store = new PeerStore();
    const left = [];
    store.onLeave = (p) => left.push(p);
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.remove('abc');

    assert.equal(left.length, 1);
    assert.equal(left[0].nickname, 'Alice');
    assert.equal(store.list().length, 0);
  });

  test('remove on unknown id is a no-op', () => {
    store = new PeerStore();
    const left = [];
    store.onLeave = (p) => left.push(p);
    store.remove('doesNotExist');
    assert.equal(left.length, 0);
  });

  test('get returns peer by id', () => {
    store = new PeerStore();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    const peer = store.get('abc');
    assert.equal(peer.nickname, 'Alice');
    assert.equal(peer.discriminator, 'a1b2');
  });

  test('findByNickname returns correct peer', () => {
    store = new PeerStore();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.update('def', 'Bob',   'c3d4', '127.0.0.2', 9001);
    const { peer, ambiguous } = store.findByNickname('Bob');
    assert.equal(peer.id, 'def');
    assert.equal(ambiguous, false);
  });

  test('findByNickname flags ambiguous when multiple peers share a nickname', () => {
    store = new PeerStore();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.update('def', 'Alice', 'c3d4', '127.0.0.2', 9001);
    const { peer, ambiguous } = store.findByNickname('Alice');
    assert.ok(peer);
    assert.equal(ambiguous, true);
  });

  test('findByNickname with discriminator resolves unambiguously', () => {
    store = new PeerStore();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.update('def', 'Alice', 'c3d4', '127.0.0.2', 9001);
    const { peer, ambiguous } = store.findByNickname('Alice#c3d4');
    assert.equal(peer.id, 'def');
    assert.equal(ambiguous, false);
  });

  test('findByNickname with wrong discriminator returns null', () => {
    store = new PeerStore();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    const { peer } = store.findByNickname('Alice#zzzz');
    assert.equal(peer, null);
  });

  test('findByNickname returns null peer for unknown nickname', () => {
    store = new PeerStore();
    const { peer } = store.findByNickname('Nobody');
    assert.equal(peer, null);
  });

  test('updateLatency stores latency on the peer', () => {
    store = new PeerStore();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.updateLatency('abc', 42);
    assert.equal(store.get('abc').latency, 42);
  });

  test('updateLatency on unknown id is a no-op', () => {
    store = new PeerStore();
    assert.doesNotThrow(() => store.updateLatency('unknown', 99));
  });

  test('stale peers are evicted and fire onLeave', async () => {
    store = new PeerStore();
    const left = [];
    store.onLeave = (p) => left.push(p);

    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);

    // Manually backdate lastSeen past the timeout
    store.peers.get('abc').lastSeen = Date.now() - 20000;

    // Trigger cleanup directly
    store._evictStale();

    assert.equal(left.length, 1);
    assert.equal(left[0].nickname, 'Alice');
    assert.equal(store.list().length, 0);
  });

  test('fresh peer is not evicted', async () => {
    store = new PeerStore();
    const left = [];
    store.onLeave = (p) => left.push(p);
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store._evictStale();
    assert.equal(left.length, 0);
    assert.equal(store.list().length, 1);
  });
});
