'use strict';

const tls    = require('tls');
const crypto = require('crypto');

const DEFAULT_TIMEOUT = 5000; // ms

// Compute SHA-256 of a raw DER cert Buffer — matches certFingerprint() in profile.js
function fingerprintOf(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// TLS connect options: we verify identity ourselves via fingerprint, so we
// disable the built-in CA chain and hostname checks.
function tlsOpts(ip) {
  return {
    host:               ip,
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  };
}

// If a fingerprint is provided, verify the peer's TLS cert matches.
// Rejects the promise and destroys the socket on mismatch.
function verifyFingerprint(socket, fingerprint, reject) {
  if (!fingerprint) return true; // no pinning requested — accept any cert
  const peerCert = socket.getPeerCertificate();
  if (!peerCert || !peerCert.raw) {
    socket.destroy();
    reject(new Error('Peer presented no TLS certificate'));
    return false;
  }
  if (fingerprintOf(peerCert.raw) !== fingerprint) {
    socket.destroy();
    reject(new Error('TLS fingerprint mismatch — possible impersonation'));
    return false;
  }
  return true;
}

// Opens a short-lived TLS connection, sends a newline-delimited JSON payload,
// then closes.  fingerprint (hex SHA-256) pins the peer's cert; pass null to
// skip pinning (used in tests and for backward-compat peers).
function sendMessage(ip, port, payload, timeout = DEFAULT_TIMEOUT, fingerprint = null) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ ...tlsOpts(ip), port }, () => {
      if (!verifyFingerprint(socket, fingerprint, reject)) return;
      socket.write(JSON.stringify(payload) + '\n', () => {
        socket.end();
        resolve();
      });
    });

    socket.setTimeout(timeout);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Connection timed out'));
    });
    socket.on('error', reject);
  });
}

// Sends a PING and waits for the PONG reply; resolves with round-trip time in ms.
function sendPing(ip, port, timeout = DEFAULT_TIMEOUT, fingerprint = null) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const socket = tls.connect({ ...tlsOpts(ip), port }, () => {
      if (!verifyFingerprint(socket, fingerprint, reject)) return;
      socket.write(JSON.stringify({ type: 'PING', timestamp: startTime }) + '\n');
    });

    socket.setTimeout(timeout);

    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.type === 'PONG') {
          socket.destroy();
          resolve(Date.now() - startTime);
          return;
        }
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Ping timed out'));
    });
    socket.on('error', reject);
  });
}

module.exports = { sendMessage, sendPing };
