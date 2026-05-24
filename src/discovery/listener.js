'use strict';

const dgram  = require('dgram');
const crypto = require('crypto');

const DISCOVERY_PORT_START = 41234;
const DISCOVERY_PORT_COUNT = 5;

// Maximum clock drift allowed for signed HELLOs — protects against replay attacks.
const MAX_TIMESTAMP_SKEW_MS = 30_000;

// Each instance binds to its own exclusive port in the discovery range so that
// the broadcaster can reach all of them without any port-sharing issues.
class Listener {
  // knownPeers: optional KnownPeers instance for TOFU verification of signed HELLOs.
  // onConflict: callback(id, nickname) fired when a signed HELLO arrives from a
  //             known device ID but with a different public key (possible impersonation).
  // space: optional namespace string — only HELLOs that share this exact value are
  //        accepted.  Must match the Broadcaster's space to enable discovery.
  constructor(deviceId, peerStore, knownPeers = null, space = '') {
    this.deviceId    = deviceId;
    this.peerStore   = peerStore;
    this._knownPeers = knownPeers;
    this._space      = space || '';
    this.onConflict  = null;
    this._socket     = null;
  }

  // Tries ports 41234, 41235, … until one is free, then resolves
  start() {
    return new Promise((resolve, reject) => {
      this._bindNext(DISCOVERY_PORT_START, DISCOVERY_PORT_START + DISCOVERY_PORT_COUNT, resolve, reject);
    });
  }

  _bindNext(port, maxPort, resolve, reject) {
    if (port >= maxPort) {
      reject(new Error(`All discovery ports ${DISCOVERY_PORT_START}–${maxPort - 1} are in use`));
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4' });

    socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));

    // If this port is taken, close and try the next one
    socket.once('error', (err) => {
      socket.close();
      if (err.code === 'EADDRINUSE') {
        this._bindNext(port + 1, maxPort, resolve, reject);
      } else {
        reject(err);
      }
    });

    socket.bind(port, () => {
      socket.removeAllListeners('error');
      socket.on('error', () => {}); // swallow post-bind errors
      this._socket    = socket;
      this.boundPort  = port;       // exposed so callers (tests) know which port we landed on
      resolve();
    });
  }

  _onMessage(buf, rinfo) {
    let packet;
    try {
      packet = JSON.parse(buf.toString());
    } catch (_) {
      return;
    }

    if (
      packet.type !== 'HELLO'         ||
      typeof packet.id       !== 'string' ||
      typeof packet.nickname !== 'string' ||
      typeof packet.port     !== 'number' ||
      packet.id === this.deviceId
    ) {
      return;
    }

    // ── Space filter ─────────────────────────────────────────────────────────
    // Both sides must use the same --space value (empty string = global/default).
    // 'space' is always a string in new packets; old packets have no field → ''.
    if ((packet.space || '') !== this._space) return;

    // ── Signature verification (signed HELLOs only) ──────────────────────────
    // If publicKey + signature are present, the HELLO is authenticated.
    // Unsigned HELLOs (no publicKey/signature) are accepted without TOFU for
    // backward compatibility with older peers.
    if (typeof packet.publicKey === 'string' && typeof packet.signature === 'string') {
      // 1. Replay attack guard — timestamp must be recent
      if (typeof packet.timestamp !== 'number' ||
          Math.abs(Date.now() - packet.timestamp) > MAX_TIMESTAMP_SKEW_MS) {
        return;
      }

      // 2. Reconstruct the canonical payload that was signed (same field order as broadcaster).
      //    'space' is included only when present in the packet — old peers that pre-date
      //    the --space feature omit the field; conditionally including it ensures their
      //    signatures still verify while preventing space-field stripping attacks.
      const canonical = JSON.stringify({
        discriminator: packet.discriminator,
        fingerprint:   packet.fingerprint,
        id:            packet.id,
        nickname:      packet.nickname,
        port:          packet.port,
        publicKey:     packet.publicKey,
        ...(packet.space !== undefined ? { space: packet.space } : {}),
        timestamp:     packet.timestamp,
      });

      // 3. Verify Ed25519 signature
      let pubKey;
      try {
        pubKey = crypto.createPublicKey({
          key:    Buffer.from(packet.publicKey, 'base64'),
          format: 'der',
          type:   'spki',
        });
      } catch (_) {
        return; // malformed public key
      }

      let valid = false;
      try {
        valid = crypto.verify(
          null,
          Buffer.from(canonical),
          pubKey,
          Buffer.from(packet.signature, 'base64')
        );
      } catch (_) {
        return;
      }
      if (!valid) return; // signature mismatch — reject

      // 4. TOFU check
      if (this._knownPeers) {
        const status = this._knownPeers.check(packet.id, packet.publicKey);
        if (status === 'conflict') {
          if (typeof this.onConflict === 'function') {
            this.onConflict(packet.id, packet.nickname);
          }
          return; // reject HELLO from ID with changed key
        }
        this._knownPeers.trust(packet.id, packet.publicKey, packet.nickname);
      }
    }

    // ── Update peer store ────────────────────────────────────────────────────
    const disc        = typeof packet.discriminator === 'string' ? packet.discriminator : packet.id.replace(/-/g, '').slice(0, 4);
    const fingerprint = typeof packet.fingerprint   === 'string' ? packet.fingerprint  : null;
    this.peerStore.update(packet.id, packet.nickname, disc, rinfo.address, packet.port, fingerprint);
  }

  stop() {
    if (this._socket) {
      try { this._socket.close(); } catch (_) {}
      this._socket = null;
    }
  }
}

module.exports = Listener;
