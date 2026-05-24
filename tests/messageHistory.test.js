'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const MessageHistory = require('../src/utils/messageHistory');

describe('MessageHistory', () => {
  test('records incoming messages and retrieves by peer id', () => {
    const h = new MessageHistory();
    h.addIncoming('peer-1', { nickname: 'Alice', discriminator: 'a1b2' }, 'hello');
    const entries = h.getById('peer-1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, 'hello');
    assert.equal(entries[0].outgoing, false);
  });

  test('records outgoing messages', () => {
    const h = new MessageHistory();
    h.addOutgoing('peer-1', 'Alice', 'a1b2', 'hey');
    const entries = h.getById('peer-1');
    assert.equal(entries[0].outgoing, true);
    assert.equal(entries[0].message, 'hey');
  });

  test('getByNickname finds entries even for offline peers', () => {
    const h = new MessageHistory();
    h.addIncoming('peer-1', { nickname: 'Alice', discriminator: 'a1b2' }, 'hi');
    const entries = h.getByNickname('Alice');
    assert.equal(entries.length, 1);
  });

  test('getByNickname returns empty array for unknown nickname', () => {
    const h = new MessageHistory();
    assert.deepEqual(h.getByNickname('Nobody'), []);
  });

  test('getRecent returns messages sorted by timestamp', () => {
    const h = new MessageHistory();
    h.addIncoming('peer-1', { nickname: 'Alice', discriminator: 'a1b2' }, 'first');
    h.addIncoming('peer-2', { nickname: 'Bob',   discriminator: 'c3d4' }, 'second');
    const recent = h.getRecent(10);
    assert.equal(recent[0].message, 'first');
    assert.equal(recent[1].message, 'second');
  });

  test('getRecent respects the n limit', () => {
    const h = new MessageHistory();
    for (let i = 0; i < 10; i++) {
      h.addIncoming('peer-1', { nickname: 'Alice', discriminator: 'a1b2' }, `msg-${i}`);
    }
    assert.equal(h.getRecent(3).length, 3);
  });

  test('caps per-peer log at 50 entries', () => {
    const h = new MessageHistory();
    for (let i = 0; i < 60; i++) {
      h.addIncoming('peer-1', { nickname: 'Alice', discriminator: 'a1b2' }, `msg-${i}`);
    }
    const entries = h.getById('peer-1');
    assert.equal(entries.length, 50);
    assert.equal(entries[0].message, 'msg-10'); // oldest 10 were evicted
  });

  test('getById returns empty array for unknown peer', () => {
    const h = new MessageHistory();
    assert.deepEqual(h.getById('unknown'), []);
  });
});
