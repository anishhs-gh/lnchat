'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_FILE = path.join(os.homedir(), '.lnchat', 'known_peers.json');

// Persists { deviceId → { publicKey, nickname, firstSeen, lastSeen } } to disk.
//
// Implements Trust On First Use (TOFU):
//   'new'      — device never seen before; caller should accept and call trust()
//   'trusted'  — device seen before, publicKey matches; accept
//   'conflict' — device seen before, but publicKey CHANGED; reject + warn user
//
// Pass a custom filePath in the constructor for isolated test instances.
class KnownPeers {
  constructor(filePath) {
    this._file  = filePath || DEFAULT_FILE;
    this._peers = this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      return (typeof data === 'object' && data !== null) ? data : {};
    } catch (_) {
      return {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      fs.writeFileSync(this._file, JSON.stringify(this._peers, null, 2), 'utf8');
    } catch (_) {} // silently ignore — read-only FS, disk full, etc.
  }

  // Returns 'new', 'trusted', or 'conflict'.
  check(id, publicKey) {
    const entry = this._peers[id];
    if (!entry) return 'new';
    return entry.publicKey === publicKey ? 'trusted' : 'conflict';
  }

  // Record or refresh a trusted peer.  Called after check() returns 'new' or 'trusted'.
  trust(id, publicKey, nickname) {
    const now = Date.now();
    if (!this._peers[id]) {
      this._peers[id] = { publicKey, nickname, firstSeen: now, lastSeen: now };
    } else {
      this._peers[id].publicKey = publicKey;
      this._peers[id].nickname  = nickname;
      this._peers[id].lastSeen  = now;
    }
    this._save();
  }

  // Remove a peer's TOFU entry — use after a legitimate account re-creation
  // so the next HELLO from that device is treated as 'new' again.
  forget(id) {
    if (this._peers[id]) {
      delete this._peers[id];
      this._save();
    }
  }

  list() {
    return Object.entries(this._peers).map(([id, data]) => ({ id, ...data }));
  }
}

module.exports = KnownPeers;
