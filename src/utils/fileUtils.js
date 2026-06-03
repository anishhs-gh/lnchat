'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// Generate a 4-character hex offer ID, e.g. "a3f7"
function generateOfferId() {
  return crypto.randomBytes(2).toString('hex');
}

// Normalize a file path from terminal drag-drop or manual input:
//   - strips surrounding single or double quotes
//   - unescapes backslash-spaces (macOS Finder drag: /my\ file.pdf)
//   - expands leading tilde
//   - resolves to absolute path
function parseFilePath(raw) {
  let p = raw.trim();
  if (
    (p.startsWith('"') && p.endsWith('"')) ||
    (p.startsWith("'") && p.endsWith("'"))
  ) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\ /g, ' ');
  if (p.startsWith('~')) {
    p = os.homedir() + p.slice(1);
  }
  return path.resolve(p);
}

// Human-readable byte count: "512 B", "1.4 KB", "2.1 MB", "1.30 GB"
function formatBytes(n) {
  if (n < 1024)                  return `${n} B`;
  if (n < 1024 * 1024)           return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024)    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Human-readable transfer speed: "2.1 MB/s"
function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

// Compute SHA-256 of a file by streaming it — never loads the whole file into RAM.
// Returns a Promise that resolves to a lowercase hex string.
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end',  ()      => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Return a path inside dir for filename that does not already exist.
// If dir/name.ext exists, tries dir/name (1).ext, dir/name (2).ext, …
// Sanitizes with path.basename to prevent path traversal.
function resolveDownloadPath(dir, filename) {
  const safe = path.basename(filename);
  const ext  = path.extname(safe);
  const base = path.basename(safe, ext);

  let candidate = path.join(dir, safe);
  let counter   = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

// Render a progress bar of given width using block characters.
// ratio must be 0.0 – 1.0; clamped silently.
// Example: renderProgressBar(0.35, 20) => "███████░░░░░░░░░░░░░"
function renderProgressBar(ratio, width = 20) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled  = Math.round(clamped * width);
  const empty   = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

module.exports = {
  generateOfferId,
  parseFilePath,
  formatBytes,
  formatSpeed,
  sha256OfFile,
  resolveDownloadPath,
  renderProgressBar,
};
