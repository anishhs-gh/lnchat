'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Point the module at a temp dir so tests don't touch ~/.lnchat
const TMP_DIR = path.join(os.tmpdir(), `lnchat-profile-test-${process.pid}`);
process.env.HOME = TMP_DIR; // profile.js uses os.homedir() which reads HOME

const { resolveProfile, listProfiles, removeProfile, discriminatorFor } = require('../src/utils/profile');

const mockUI = (answer = 'Tester') => ({
  question: async () => answer,
});

describe('profile', () => {
  before(() => fs.mkdirSync(TMP_DIR, { recursive: true }));
  after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

  test('discriminatorFor returns a 4-char hex string', () => {
    const disc = discriminatorFor('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    assert.match(disc, /^[0-9a-f]{4}$/);
  });

  test('discriminatorFor is deterministic', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    assert.equal(discriminatorFor(id), discriminatorFor(id));
  });

  test('resolveProfile creates profile on first use and persists it', async () => {
    const p = await resolveProfile('new-profile', false, mockUI('Alice'));
    assert.equal(p.nickname, 'Alice');
    assert.equal(typeof p.deviceId, 'string');
    assert.equal(p.discriminator, discriminatorFor(p.deviceId));

    // Second call should load from disk, not prompt again
    const p2 = await resolveProfile('new-profile', false, mockUI('ShouldNotBeUsed'));
    assert.equal(p2.nickname, 'Alice');
    assert.equal(p2.deviceId, p.deviceId);
  });

  test('resolveProfile with forceNew ignores saved profile', async () => {
    await resolveProfile('force-profile', false, mockUI('Original'));
    const p = await resolveProfile('force-profile', true, mockUI('Replaced'));
    assert.equal(p.nickname, 'Replaced');
  });

  test('listProfiles returns all saved profiles', async () => {
    await resolveProfile('list-a', false, mockUI('UserA'));
    await resolveProfile('list-b', false, mockUI('UserB'));
    const all = listProfiles();
    const names = all.map(p => p.name);
    assert.ok(names.includes('list-a'));
    assert.ok(names.includes('list-b'));
    const a = all.find(p => p.name === 'list-a');
    assert.equal(a.nickname, 'UserA');
    assert.equal(a.discriminator.length, 4);
  });

  test('removeProfile deletes the profile and returns true', async () => {
    await resolveProfile('to-remove', false, mockUI('Gone'));
    const result = removeProfile('to-remove');
    assert.equal(result, true);
    const after = listProfiles().find(p => p.name === 'to-remove');
    assert.equal(after, undefined);
  });

  test('removeProfile returns false for a non-existent profile', () => {
    const result = removeProfile('does-not-exist');
    assert.equal(result, false);
  });
});
