'use strict';

// A peer is considered offline if no heartbeat is received within this window
const PEER_TIMEOUT_MS = 15000;

class PeerStore {
  constructor() {
    // Map<id, { id, nickname, ip, port, lastSeen }>
    this.peers = new Map();

    // Callbacks set by the caller
    this.onJoin  = null;
    this.onLeave = null;

    // Periodically evict stale peers
    this._cleanupTimer = setInterval(() => this._evictStale(), 5000);
    this._cleanupTimer.unref(); // don't keep the process alive just for cleanup
  }

  // Called on every received HELLO — inserts or refreshes a peer.
  // fingerprint is the peer's TLS cert SHA-256 (hex), or null for legacy peers.
  update(id, nickname, discriminator, ip, port, fingerprint = null) {
    const now      = Date.now();
    const existing = this.peers.get(id);

    if (!existing) {
      this.peers.set(id, { id, nickname, discriminator, ip, port, fingerprint, lastSeen: now, latency: null });
      if (this.onJoin) this.onJoin({ id, nickname, discriminator });
    } else {
      existing.nickname      = nickname;
      existing.discriminator = discriminator;
      existing.fingerprint   = fingerprint;
      // Prefer loopback address: if we already know this peer is on the same machine
      // (ip === 127.0.0.1), don't overwrite with its WiFi IP. Loopback bypasses the
      // macOS Application Firewall; the WiFi IP does not.
      if (existing.ip !== '127.0.0.1') existing.ip = ip;
      existing.port     = port;
      existing.lastSeen = now;
    }
  }

  // Store the last measured round-trip time (ms) for a peer
  updateLatency(id, ms) {
    const peer = this.peers.get(id);
    if (peer) peer.latency = ms;
  }

  remove(id) {
    const peer = this.peers.get(id);
    if (peer) {
      this.peers.delete(id);
      if (this.onLeave) this.onLeave(peer);
    }
  }

  get(id)               { return this.peers.get(id); }
  list()                { return Array.from(this.peers.values()); }

  // Accepts plain "Name" or qualified "Name#disc".
  // Returns { peer, ambiguous } — ambiguous is true only for plain-name matches with 2+ results.
  findByNickname(input) {
    const hashIdx = input.lastIndexOf('#');
    if (hashIdx !== -1) {
      const name = input.slice(0, hashIdx);
      const disc = input.slice(hashIdx + 1);
      for (const peer of this.peers.values()) {
        if (peer.nickname === name && peer.discriminator === disc) {
          return { peer, ambiguous: false };
        }
      }
      return { peer: null, ambiguous: false };
    }

    const matches = [];
    for (const peer of this.peers.values()) {
      if (peer.nickname === input) matches.push(peer);
    }
    return { peer: matches[0] || null, ambiguous: matches.length > 1 };
  }

  _evictStale() {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const [id, peer] of this.peers.entries()) {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(id);
        if (this.onLeave) this.onLeave(peer);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer);
  }
}

module.exports = PeerStore;
