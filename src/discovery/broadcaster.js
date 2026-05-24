'use strict';

const dgram  = require('dgram');
const crypto = require('crypto');
const { getSubnetBroadcasts } = require('../utils/network');

const LOOPBACK_ADDR        = '127.0.0.1';
const DISCOVERY_PORT_START = 41234;
const DISCOVERY_PORT_COUNT = 5;
const BROADCAST_INTERVAL   = 5000;

class Broadcaster {
  // signingKey: private key PEM string (Ed25519).  When provided, every HELLO
  // packet is signed and includes publicKey + signature fields.  Pass null to
  // send unsigned HELLOs (backward-compatible with pre-TOFU peers).
  // space: optional namespace string — peers only discover each other when both
  //        share the same space value.  Empty string (default) = global space.
  constructor(deviceId, nickname, discriminator, tcpPort, fingerprint = null, signingKey = null, space = '') {
    this.deviceId      = deviceId;
    this.nickname      = nickname;
    this.discriminator = discriminator;
    this.tcpPort       = tcpPort;
    this.fingerprint   = fingerprint; // SHA-256 of our TLS cert, included in HELLO
    this._space        = space || '';

    // Derive the public key from the private key so we only need to pass one thing.
    if (signingKey) {
      this._signingKey   = crypto.createPrivateKey(signingKey);
      const pubKeyObj    = crypto.createPublicKey(this._signingKey);
      this._publicKeyB64 = pubKeyObj.export({ type: 'spki', format: 'der' }).toString('base64');
    } else {
      this._signingKey   = null;
      this._publicKeyB64 = null;
    }

    this._socket = null;
    this._timer  = null;
  }

  start() {
    this._socket = dgram.createSocket({ type: 'udp4' });
    this._socket.on('error', () => {});

    this._socket.bind(() => {
      this._socket.setBroadcast(true);
      this._send();
      this._timer = setInterval(() => this._send(), BROADCAST_INTERVAL);
    });
  }

  _send() {
    const timestamp = Date.now();

    const hello = {
      type:          'HELLO',
      id:            this.deviceId,
      nickname:      this.nickname,
      discriminator: this.discriminator,
      port:          this.tcpPort,
      fingerprint:   this.fingerprint,
      space:         this._space,
      timestamp,
    };

    if (this._signingKey && this._publicKeyB64) {
      // Canonical payload: alphabetical key order, no 'type', no 'signature'.
      // Receiver reconstructs the same string to verify — order must be identical.
      // 'space' sits alphabetically between 'publicKey' and 'timestamp'.
      const canonical = JSON.stringify({
        discriminator: this.discriminator,
        fingerprint:   this.fingerprint,
        id:            this.deviceId,
        nickname:      this.nickname,
        port:          this.tcpPort,
        publicKey:     this._publicKeyB64,
        space:         this._space,
        timestamp,
      });
      hello.publicKey  = this._publicKeyB64;
      hello.signature  = crypto.sign(null, Buffer.from(canonical), this._signingKey).toString('base64');
    }

    const packet = Buffer.from(JSON.stringify(hello));

    // Compute fresh each send so we pick up new interfaces (e.g. WiFi connects after start)
    const subnetBroadcasts = getSubnetBroadcasts();

    for (let i = 0; i < DISCOVERY_PORT_COUNT; i++) {
      const port = DISCOVERY_PORT_START + i;

      // Loopback: reaches other instances on the same machine instantly and bypasses
      // the macOS Application Firewall (loopback connections are always allowed)
      this._socket.send(packet, 0, packet.length, port, LOOPBACK_ADDR);

      // Subnet broadcast on each active interface: reaches machines on the same LAN.
      // Using the directed broadcast (e.g. 192.168.1.255) instead of 255.255.255.255
      // ensures the packet goes out on the right interface on multi-homed hosts.
      for (const bcast of subnetBroadcasts) {
        this._socket.send(packet, 0, packet.length, port, bcast);
      }
    }
  }

  stop() {
    clearInterval(this._timer);
    if (this._socket) {
      try { this._socket.close(); } catch (_) {}
      this._socket = null;
    }
  }
}

module.exports = Broadcaster;
