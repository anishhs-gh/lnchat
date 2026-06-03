'use strict';

const tls    = require('tls');
const fs     = require('fs');
const crypto = require('crypto');
const { sha256OfFile } = require('../utils/fileUtils');

// Compute SHA-256 fingerprint of a raw DER cert Buffer —
// mirrors the same helper in tcpClient.js.
function fingerprintOf(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Connect to senderIp:dataPort over TLS, verify the sender's cert fingerprint,
// and stream incoming bytes to savePath.
//
// Parameters:
//   senderIp        — IP address of the sender
//   dataPort        — port of the sender's FileDataServer
//   senderFingerprint — SHA-256 hex fingerprint to pin; pass null to skip
//   savePath        — absolute path to write to
//   offset          — byte offset to resume from (0 for fresh start)
//   onProgress      — optional callback(totalBytesReceived) called on each chunk
//
// Returns { promise, pause(), resume(), cancel() }
//
// promise resolves with { bytesReceived, sha256 } where sha256 is the hash of
// the ENTIRE saved file (handles resume correctly).
// promise rejects on connection error, fingerprint mismatch, or write error.
function receiveFile(senderIp, dataPort, senderFingerprint, savePath, offset = 0, onProgress = null) {
  let _socket     = null;
  let _fileStream = null;
  let _cancelled  = false;

  const promise = new Promise((resolve, reject) => {
    const socket = tls.connect({
      host:               senderIp,
      port:               dataPort,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });

    _socket = socket;

    socket.on('secureConnect', () => {
      // ── Fingerprint verification (same pattern as tcpClient.js:26–38) ─────
      if (senderFingerprint) {
        const peerCert = socket.getPeerCertificate();
        if (!peerCert || !peerCert.raw) {
          socket.destroy();
          reject(new Error('Sender presented no TLS certificate'));
          return;
        }
        if (fingerprintOf(peerCert.raw) !== senderFingerprint) {
          socket.destroy();
          reject(new Error('TLS fingerprint mismatch — possible impersonation'));
          return;
        }
      }

      // ── File write stream ─────────────────────────────────────────────────
      // 'a' (append) for resume, 'w' (overwrite) for fresh start
      const flags      = offset > 0 ? 'a' : 'w';
      const fileStream = fs.createWriteStream(savePath, { flags });
      _fileStream      = fileStream;

      fileStream.on('error', (err) => {
        socket.destroy();
        if (!_cancelled) reject(err);
      });

      let bytesReceived = 0;

      // Manual data handling to combine backpressure and progress reporting
      socket.on('data', (chunk) => {
        bytesReceived += chunk.length;
        if (onProgress) onProgress(offset + bytesReceived);

        const canContinue = fileStream.write(chunk);
        if (!canContinue) socket.pause(); // apply backpressure
      });

      fileStream.on('drain', () => socket.resume());

      socket.on('end', () => {
        fileStream.end(async () => {
          if (_cancelled) return;
          try {
            // Hash the entire file so resume verification works correctly
            const hash = await sha256OfFile(savePath);
            resolve({ bytesReceived: offset + bytesReceived, sha256: hash });
          } catch (e) {
            reject(e);
          }
        });
      });
    });

    socket.setTimeout(30000);
    socket.on('timeout', () => {
      socket.destroy();
      if (!_cancelled) reject(new Error('Data connection timed out'));
    });

    socket.on('error', (err) => {
      if (!_cancelled) reject(err);
    });
  });

  return {
    promise,

    pause() {
      if (_socket) _socket.pause();
    },

    resume() {
      if (_socket) _socket.resume();
    },

    // Cancel the in-progress receive and delete the partial file from disk.
    cancel() {
      _cancelled = true;
      if (_socket)     { _socket.destroy();     _socket     = null; }
      if (_fileStream) { _fileStream.destroy();  _fileStream = null; }
      try { fs.unlinkSync(savePath); } catch (_) {}
    },
  };
}

module.exports = { receiveFile };
