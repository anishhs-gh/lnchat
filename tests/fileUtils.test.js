'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  generateOfferId,
  parseFilePath,
  formatBytes,
  formatSpeed,
  sha256OfFile,
  resolveDownloadPath,
  renderProgressBar,
} = require('../src/utils/fileUtils');

describe('generateOfferId', () => {
  test('returns a 4-character string', () => {
    assert.equal(generateOfferId().length, 4);
  });

  test('is lowercase hex', () => {
    const id = generateOfferId();
    assert.match(id, /^[0-9a-f]{4}$/);
  });

  test('generates distinct values across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateOfferId()));
    assert.ok(ids.size > 1);
  });
});

describe('parseFilePath', () => {
  test('resolves a plain absolute path', () => {
    const result = parseFilePath('/tmp/file.txt');
    assert.equal(result, '/tmp/file.txt');
  });

  test('strips double quotes', () => {
    const result = parseFilePath('"/tmp/my file.txt"');
    assert.equal(result, '/tmp/my file.txt');
  });

  test('strips single quotes', () => {
    const result = parseFilePath("'/tmp/my file.txt'");
    assert.equal(result, '/tmp/my file.txt');
  });

  test('unescapes backslash-spaces', () => {
    const result = parseFilePath('/tmp/my\\ file.txt');
    assert.equal(result, '/tmp/my file.txt');
  });

  test('expands leading tilde', () => {
    const result = parseFilePath('~/Downloads/file.pdf');
    assert.equal(result, path.join(os.homedir(), 'Downloads/file.pdf'));
  });

  test('trims surrounding whitespace', () => {
    const result = parseFilePath('  /tmp/file.txt  ');
    assert.equal(result, '/tmp/file.txt');
  });
});

describe('formatBytes', () => {
  test('bytes', () => {
    assert.equal(formatBytes(0),   '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  test('kilobytes', () => {
    assert.equal(formatBytes(1024),       '1.0 KB');
    assert.equal(formatBytes(1024 * 1.5), '1.5 KB');
  });

  test('megabytes', () => {
    assert.equal(formatBytes(1024 * 1024),       '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 2.1), '2.1 MB');
  });

  test('gigabytes', () => {
    const gb = 1024 * 1024 * 1024;
    assert.equal(formatBytes(gb), '1.00 GB');
  });
});

describe('formatSpeed', () => {
  test('appends /s to byte count', () => {
    assert.equal(formatSpeed(1024 * 1024), '1.0 MB/s');
    assert.equal(formatSpeed(512),         '512 B/s');
  });
});

describe('sha256OfFile', () => {
  test('returns a 64-char hex string', async () => {
    const tmp = path.join(os.tmpdir(), `lnchat-test-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'hello world');
    const hash = await sha256OfFile(tmp);
    assert.match(hash, /^[0-9a-f]{64}$/);
    fs.unlinkSync(tmp);
  });

  test('same content produces the same hash', async () => {
    const tmp = path.join(os.tmpdir(), `lnchat-test-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'deterministic content');
    const h1 = await sha256OfFile(tmp);
    const h2 = await sha256OfFile(tmp);
    assert.equal(h1, h2);
    fs.unlinkSync(tmp);
  });

  test('different content produces different hashes', async () => {
    const tmp1 = path.join(os.tmpdir(), `lnchat-a-${Date.now()}.txt`);
    const tmp2 = path.join(os.tmpdir(), `lnchat-b-${Date.now()}.txt`);
    fs.writeFileSync(tmp1, 'content A');
    fs.writeFileSync(tmp2, 'content B');
    const h1 = await sha256OfFile(tmp1);
    const h2 = await sha256OfFile(tmp2);
    assert.notEqual(h1, h2);
    fs.unlinkSync(tmp1);
    fs.unlinkSync(tmp2);
  });

  test('rejects on missing file', async () => {
    await assert.rejects(sha256OfFile('/nonexistent/path/file.txt'));
  });
});

describe('resolveDownloadPath', () => {
  test('returns dir/name when no conflict', () => {
    const dir    = os.tmpdir();
    const unique = `lnchat-noconflict-${Date.now()}.txt`;
    const result = resolveDownloadPath(dir, unique);
    assert.equal(result, path.join(dir, unique));
  });

  test('increments counter on conflict', () => {
    const dir  = os.tmpdir();
    const name = `lnchat-conflict-${Date.now()}.txt`;
    const base = name.replace('.txt', '');
    const p1   = path.join(dir, name);
    fs.writeFileSync(p1, '');
    const result = resolveDownloadPath(dir, name);
    assert.equal(result, path.join(dir, `${base} (1).txt`));
    fs.unlinkSync(p1);
  });

  test('sanitizes filename to prevent path traversal', () => {
    const dir    = os.tmpdir();
    const result = resolveDownloadPath(dir, '../../etc/passwd');
    assert.equal(result, path.join(dir, 'passwd'));
  });
});

describe('renderProgressBar', () => {
  test('all empty at 0', () => {
    assert.equal(renderProgressBar(0, 4), '░░░░');
  });

  test('all filled at 1', () => {
    assert.equal(renderProgressBar(1, 4), '████');
  });

  test('half filled', () => {
    assert.equal(renderProgressBar(0.5, 4), '██░░');
  });

  test('clamps below 0', () => {
    assert.equal(renderProgressBar(-0.5, 4), '░░░░');
  });

  test('clamps above 1', () => {
    assert.equal(renderProgressBar(1.5, 4), '████');
  });

  test('defaults to width 20', () => {
    assert.equal(renderProgressBar(0).length, 20);
  });
});
