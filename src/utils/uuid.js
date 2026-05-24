'use strict';

const crypto = require('crypto');

// Generate a fresh UUID each session. A persistent per-machine ID would cause
// two instances on the same machine to share the same ID, making each treat
// the other as itself and silently drop all discovery packets.
function getDeviceId() {
  return crypto.randomUUID();
}

module.exports = { getDeviceId };
