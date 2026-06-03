'use strict';

const tls = require('tls');

// Opens a TLS server on the given port.
// tlsCredentials must be { cert, key } — PEM strings for the self-signed cert
// generated at profile creation.  All traffic is encrypted; peers verify our
// cert fingerprint (announced in the HELLO packet) before sending.
// Handles newline-delimited JSON messages from peers.
// Responds to PING with PONG on the same socket; calls onMessage for MESSAGE types.
class TCPServer {
  constructor(preferredPort, onMessage, tlsCredentials) {
    this.preferredPort   = preferredPort;
    this.onMessage       = onMessage;
    this._tlsCredentials = tlsCredentials || null;
    this.onTyping             = null; // optional: called with from when a TYPING packet arrives
    this.onStopTyping         = null; // optional: called with from when a STOP_TYPING packet arrives
    this.onFileOffer          = null;
    this.onFileAccept         = null;
    this.onFileReject         = null;
    this.onFileReady          = null;
    this.onFileCancel         = null;
    this.onFilePause          = null;
    this.onFileResume         = null;
    this.onFileResumeRequest  = null;
    this._server              = null;
  }

  start() {
    const tlsOpts = this._tlsCredentials
      ? { cert: this._tlsCredentials.cert, key: this._tlsCredentials.key, rejectUnauthorized: false }
      : {};

    this._server = tls.createServer(tlsOpts, (socket) => this._handleConnection(socket));

    // Build the list of ports to attempt. When --port was specified the caller
    // passes that as preferredPort and we try it alone before falling back to
    // OS-assigned 0. Without --port we try the full 9000–9009 range first so
    // that multiple local profiles each land on a predictable, firewallable port.
    const preferred = this.preferredPort;
    const isDefaultPort = (preferred === 9000);
    const portQueue = isDefaultPort
      ? [9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 0]
      : [preferred, 0];

    return new Promise((resolve, reject) => {
      const tryPort = (idx) => {
        const p = portQueue[idx];
        this._server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && idx + 1 < portQueue.length) {
            tryPort(idx + 1);
          } else if (err.code !== 'EADDRINUSE') {
            reject(err);
          } else {
            reject(new Error(`All ports in range ${portQueue[0]}–${portQueue[portQueue.length - 2]} are in use.`));
          }
        });
        this._server.listen(p, '0.0.0.0', () => {
          this._server.on('error', () => {}); // swallow post-bind runtime errors
          resolve(this._server.address().port);
        });
      };
      tryPort(0);
    });
  }

  _handleConnection(socket) {
    socket.setKeepAlive(true);
    let buf = '';

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      // Messages are newline-delimited JSON
      const lines = buf.split('\n');
      buf = lines.pop(); // keep any incomplete trailing fragment
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          continue; // malformed — skip
        }
        this._dispatch(msg, socket);
      }
    });

    socket.on('error', () => {}); // swallow peer disconnect errors
    socket.on('close', () => {});
  }

  _dispatch(msg, socket) {
    if (msg.type === 'PING') {
      // Reply on the same socket so the sender can measure RTT
      try {
        socket.write(JSON.stringify({ type: 'PONG', timestamp: msg.timestamp }) + '\n');
      } catch (_) {}
      return;
    }

    if (msg.type === 'MESSAGE' && this.onMessage) {
      this.onMessage(msg);
      return;
    }

    if (msg.type === 'TYPING' && this.onTyping && msg.from) {
      this.onTyping(msg.from);
      return;
    }

    if (msg.type === 'STOP_TYPING' && this.onStopTyping && msg.from) {
      this.onStopTyping(msg.from);
      return;
    }

    if (msg.type === 'FILE_OFFER'          && this.onFileOffer)         { this.onFileOffer(msg);         return; }
    if (msg.type === 'FILE_ACCEPT'         && this.onFileAccept)        { this.onFileAccept(msg);        return; }
    if (msg.type === 'FILE_REJECT'         && this.onFileReject)        { this.onFileReject(msg);        return; }
    if (msg.type === 'FILE_READY'          && this.onFileReady)         { this.onFileReady(msg);         return; }
    if (msg.type === 'FILE_CANCEL'         && this.onFileCancel)        { this.onFileCancel(msg);        return; }
    if (msg.type === 'FILE_PAUSE'          && this.onFilePause)         { this.onFilePause(msg);         return; }
    if (msg.type === 'FILE_RESUME'         && this.onFileResume)        { this.onFileResume(msg);        return; }
    if (msg.type === 'FILE_RESUME_REQUEST' && this.onFileResumeRequest) { this.onFileResumeRequest(msg); return; }
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }
}

module.exports = TCPServer;
