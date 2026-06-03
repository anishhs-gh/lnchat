'use strict';

const crypto = require('crypto');

// Derive an opaque token from spaceName + passphrase using PBKDF2-SHA256.
// The token is what goes into HELLO packets instead of the plain space name,
// so only peers who know the passphrase derive the same token and can see
// each other.
//
// Empty passphrase → return spaceName unchanged. This preserves full backward
// compatibility: v1.0.0 peers and v2 peers without a passphrase both broadcast
// the raw space name and can discover each other, but they can never match a
// derived token, so they are silently excluded from protected spaces.
function deriveSpaceToken(spaceName, passphrase) {
  if (!passphrase) return spaceName;
  return crypto.pbkdf2Sync(passphrase, spaceName, 50_000, 16, 'sha256').toString('hex');
}

module.exports = { deriveSpaceToken };
