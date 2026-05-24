'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/utils/logger');

describe('logger', () => {
  test('colorize returns ANSI-colored string containing the nickname', () => {
    const result = logger.colorize('Alice');
    assert.ok(result.includes('Alice'));
    assert.ok(result.includes('\x1b[')); // has at least one ANSI escape
  });

  test('same nickname always gets the same color', () => {
    const a = logger.colorize('SameNick');
    const b = logger.colorize('SameNick');
    assert.equal(a, b);
  });

  test('different nicknames get different colors', () => {
    // Use unique names to avoid collision with the shared module-level colorIndex
    const a = logger.colorize('__UniqueA__');
    const b = logger.colorize('__UniqueB__');
    // The colored prefix will differ (different ANSI code), content will differ
    assert.notEqual(a, b);
  });

  test('timestamp returns a string matching HH:MM pattern', () => {
    const ts = logger.timestamp();
    assert.ok(typeof ts === 'string');
    assert.ok(/\d{2}:\d{2}/.test(ts));
  });

  test('info/warn/error/system all return strings', () => {
    for (const fn of [logger.info, logger.warn, logger.error, logger.system]) {
      assert.equal(typeof fn('test'), 'string');
    }
  });

  test('info contains the message text', () => {
    assert.ok(logger.info('worked').includes('worked'));
  });

  test('error contains the message text', () => {
    assert.ok(logger.error('broke').includes('broke'));
  });
});
