'use strict';

const dgram  = require('dgram');
const crypto = require('crypto');
const events = require('events');

// Encrypted UDP media channel for one call — the voice analogue of FileDataServer,
// but connectionless and real-time. Uses only Node built-ins (dgram + crypto):
//
//   • One UDP socket per call, bound to an ephemeral port.
//   • Each audio frame is encrypted with AES-256-GCM under a shared 32-byte key
//     that the peers exchanged over the TLS+fingerprint-pinned control channel.
//   • Nonce = [directionByte][0,0,0][seq:8]. The caller sends with direction 0,
//     the callee with direction 1, so the two streams never share a (key, nonce)
//     pair even though they reuse one key — which is what GCM requires.
//   • Wire packet = [seq:8 BE][ciphertext][tag:16]. The receiver rebuilds the
//     nonce from the peer's direction (the opposite of its own) + the seq.
//   • Frames that fail authentication (wrong key / tampered / truncated) are
//     silently dropped, exactly as a corrupt UDP datagram would be.
//
// UDP is deliberate: a lost or late packet must never stall the stream the way
// TCP head-of-line blocking would. Loss just means a dropped 20 ms frame.
class MediaSocket extends events.EventEmitter {
  // direction: 0 for the caller, 1 for the callee (decides the nonce prefix).
  constructor(key, direction) {
    super();
    this._key       = key;                 // 32-byte Buffer (AES-256)
    this._dir       = direction & 0xff;    // our send direction
    this._peerDir   = this._dir ^ 1;       // peer's direction (for decrypt)
    this._socket    = null;
    this._remoteIp  = null;
    this._remotePort = null;
    this._sendSeq   = 0n;                   // 64-bit send counter
    this.bytesSent  = 0;
    this.bytesRecv  = 0;
    this.framesRecv = 0;
  }

  // Bind to an ephemeral UDP port on all interfaces; resolves with the port.
  bind() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      this._socket = socket;
      socket.on('error', (err) => {
        // Pre-bind errors reject; post-bind runtime errors are swallowed (a peer
        // going away mid-call should not crash the process).
        if (this._remotePort === null) reject(err);
      });
      socket.on('message', (msg) => this._onMessage(msg));
      socket.bind(0, '0.0.0.0', () => resolve(socket.address().port));
    });
  }

  // Where to send our encrypted frames (the peer's IP + media port).
  setRemote(ip, port) {
    this._remoteIp   = ip;
    this._remotePort = port;
  }

  // Encrypt one PCM frame (Int16Array) and send it to the peer.
  send(int16) {
    if (!this._socket || this._remotePort === null) return;

    const seq   = this._sendSeq++;
    const nonce = this._nonce(this._dir, seq);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key, nonce);

    const plain = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
    const ct    = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag   = cipher.getAuthTag();

    const header = Buffer.allocUnsafe(8);
    header.writeBigUInt64BE(seq);

    const packet = Buffer.concat([header, ct, tag]);
    this._socket.send(packet, this._remotePort, this._remoteIp, () => {});
    this.bytesSent += packet.length;
  }

  _onMessage(msg) {
    // [seq:8][ciphertext][tag:16] — minimum is 8 + 0 + 16 = 24 bytes.
    if (msg.length < 24) return;

    const seq = msg.readBigUInt64BE(0);
    const tag = msg.subarray(msg.length - 16);
    const ct  = msg.subarray(8, msg.length - 16);
    const nonce = this._nonce(this._peerDir, seq);

    let plain;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this._key, nonce);
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (_) {
      return; // auth failure — forged, tampered, or stray packet; drop it
    }

    this.bytesRecv += msg.length;
    this.framesRecv++;

    // Reinterpret the decrypted bytes as Int16 PCM. Copy into an aligned buffer
    // so the Int16Array view is valid regardless of the slice's byte offset.
    const aligned = Buffer.from(plain);
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length >> 1);
    this.emit('frame', samples, seq);
  }

  // 12-byte GCM nonce: [dir:1][0:3][seq:8 BE].
  _nonce(dir, seq) {
    const n = Buffer.alloc(12);
    n.writeUInt8(dir & 0xff, 0);
    n.writeBigUInt64BE(seq, 4);
    return n;
  }

  close() {
    if (this._socket) {
      try { this._socket.close(); } catch (_) {}
      this._socket = null;
    }
    this.removeAllListeners();
  }
}

module.exports = MediaSocket;
