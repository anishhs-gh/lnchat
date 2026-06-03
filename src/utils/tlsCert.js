'use strict';

const crypto = require('crypto');

// ── Minimal DER/ASN.1 primitives ─────────────────────────────────────────────

function _len(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
function _tlv(tag, data) {
  return Buffer.concat([Buffer.from([tag]), _len(data.length), data]);
}
function _seq(d)  { return _tlv(0x30, d); }
function _set(d)  { return _tlv(0x31, d); }
function _int(b) {
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return _tlv(0x02, b);
}
function _bits(d) { return _tlv(0x03, Buffer.concat([Buffer.from([0x00]), d])); }
function _oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (let i = 2; i < p.length; i++) {
    let v = p[i];
    const chunk = [v & 0x7f];
    v >>= 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...chunk);
  }
  return _tlv(0x06, Buffer.from(out));
}
function _utf8(s) { return _tlv(0x0c, Buffer.from(s, 'utf8')); }
function _ctx0(d) { return _tlv(0xa0, d); } // [0] EXPLICIT CONSTRUCTED
function _utcTime(d) {
  const s = d.toISOString().replace(/[-:.TZ]/g, '').slice(2, 14) + 'Z';
  return _tlv(0x17, Buffer.from(s, 'ascii'));
}
function _name(cn) {
  return _seq(_set(_seq(Buffer.concat([_oid('2.5.4.3'), _utf8(cn)]))));
}

// ── Public API ────────────────────────────────────────────────────────────────

// Generate an RSA-2048 key pair and a matching self-signed X.509 v3 cert.
// Returns { cert, key } as PEM strings — no file I/O, no external binaries.
function generateSelfSignedCert(cn = 'lnchat') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength:      2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });
  return { cert: signCert(publicKey, privateKey, cn), key: privateKey };
}

// Build a self-signed X.509 v3 DER cert (sha256WithRSAEncryption) from an
// existing RSA key pair and return it as PEM.  Call this when you already have
// the key and only need a matching cert.
function signCert(publicKeyPem, privateKeyPem, cn = 'lnchat') {
  const sigAlg = _seq(Buffer.concat([
    _oid('1.2.840.113549.1.1.11'), // sha256WithRSAEncryption
    Buffer.from([0x05, 0x00]),      // NULL parameters
  ]));

  const spki    = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const now     = new Date();
  const expires = new Date(now); expires.setFullYear(expires.getFullYear() + 10);

  const tbs = _seq(Buffer.concat([
    _ctx0(_int(Buffer.from([0x02]))),                          // version v3
    _int(crypto.randomBytes(8)),                               // serialNumber
    sigAlg,
    _name(cn),                                                 // issuer
    _seq(Buffer.concat([_utcTime(now), _utcTime(expires)])),   // validity
    _name(cn),                                                 // subject
    spki,                                                      // subjectPublicKeyInfo
  ]));

  const signer = crypto.createSign('SHA256');
  signer.update(tbs);
  const der = _seq(Buffer.concat([tbs, sigAlg, _bits(signer.sign(privateKeyPem))]));
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

module.exports = { generateSelfSignedCert, signCert };
