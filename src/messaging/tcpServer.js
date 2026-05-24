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
    this.onTyping        = null; // optional: called with from when a TYPING packet arrives
    this.onStopTyping    = null; // optional: called with from when a STOP_TYPING packet arrives
    this._server         = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const tlsOpts = this._tlsCredentials
        ? { cert: this._tlsCredentials.cert, key: this._tlsCredentials.key, rejectUnauthorized: false }
        : {};

      this._server = tls.createServer(tlsOpts, (socket) => this._handleConnection(socket));

      // Single error handler so EADDRINUSE doesn't both reject AND fall through
      this._server.once('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        // Port taken — ask OS for any free port
        this._server.listen(0, '0.0.0.0', () => {
          this._server.on('error', () => {});
          resolve(this._server.address().port);
        });
        this._server.once('error', reject); // catch errors on the retry bind
      });

      this._server.listen(this.preferredPort, '0.0.0.0', () => {
        this._server.on('error', () => {}); // swallow post-bind runtime errors
        resolve(this._server.address().port);
      });
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
    }
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }
}

module.exports = TCPServer;
