'use strict';

// Shared TLS credentials and Ed25519 signing keys for tests.
// Generated once at module load and cached for the entire test run.
// No file I/O, no external binaries — pure Node crypto.

const crypto = require('crypto');
const { generateSelfSignedCert } = require('../src/utils/tlsCert');

// ── TLS credentials ───────────────────────────────────────────────────────────
const { cert: _cert, key: _key } = generateSelfSignedCert('lnchat-test');

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
  key:  _key,
  cert: _cert,

  // Ed25519 signing key (PEM) — pass to Broadcaster constructor as signingKey
  signingKey:          _signPrivPem,
  signingPublicKeyB64,
  signHello,
};
