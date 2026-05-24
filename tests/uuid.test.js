'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { getDeviceId } = require('../src/utils/uuid');

describe('uuid', () => {
  test('getDeviceId returns a 36-character UUID string', () => {
    const id = getDeviceId();
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 36);
  });

  test('getDeviceId only contains hex digits and hyphens', () => {
    const id = getDeviceId();
    assert.match(id, /^[0-9a-f-]+$/);
  });

  test('getDeviceId returns a unique ID on each call', () => {
    const id1 = getDeviceId();
    const id2 = getDeviceId();
    assert.notEqual(id1, id2);
  });
});
