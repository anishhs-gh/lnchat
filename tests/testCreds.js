'use strict';

// Shared TLS credentials and Ed25519 signing keys for tests.
// Generated once and cached.  All tests that spin up a TCPServer or exercise
// signed-HELLO paths import this module to get valid credentials.

const { execSync } = require('child_process');
const crypto = require('crypto');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ── TLS credentials ───────────────────────────────────────────────────────────
const keyPath  = path.join(os.tmpdir(), 'lnchat-test-key.pem');
const certPath = path.join(os.tmpdir(), 'lnchat-test-cert.pem');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
    `-days 1 -nodes -subj "/CN=lnchat-test" 2>/dev/null`,
    { stdio: 'pipe' }
  );
}

// ── Ed25519 signing keys ──────────────────────────────────────────────────────
// Generated in-process each test run (fast, no file I/O needed for tests)
const { privateKey: _signPrivPem, publicKey: _signPubPem } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});

const _signingPrivKeyObj = crypto.createPrivateKey(_signPrivPem);
const _signingPubKeyObj  = crypto.createPublicKey(_signingPrivKeyObj);

// Base64-encoded SPKI DER — the format included in HELLO packets
const signingPublicKeyB64 = _signingPubKeyObj.export({ type: 'spki', format: 'der' }).toString('base64');

// Sign a canonical HELLO payload exactly as Broadcaster does.
// Pass the same fields object used to build the HELLO packet;
// publicKey defaults to signingPublicKeyB64 if not provided.
// space defaults to '' (global space) — mirrors the broadcaster's default.
function signHello(fields) {
  const canonical = JSON.stringify({
    discriminator: fields.discriminator,
    fingerprint:   fields.fingerprint,
    id:            fields.id,
    nickname:      fields.nickname,
    port:          fields.port,
    publicKey:     fields.publicKey !== undefined ? fields.publicKey : signingPublicKeyB64,
    space:         fields.space     !== undefined ? fields.space     : '',
    timestamp:     fields.timestamp,
  });
  return crypto.sign(null, Buffer.from(canonical), _signingPrivKeyObj).toString('base64');
}

module.exports = {
  key:  fs.readFileSync(keyPath,  'utf8'),
  cert: fs.readFileSync(certPath, 'utf8'),

  // Ed25519 signing key (PEM) — pass to Broadcaster constructor as signingKey
  signingKey:          _signPrivPem,
  signingPublicKeyB64,
  signHello,
};
