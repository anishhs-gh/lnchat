'use strict';

const tls    = require('tls');
const fs     = require('fs');
const events = require('events');

const DEFAULT_ACCEPT_TIMEOUT_MS = 30000;

// One-shot TLS data server for sending a file.
//
// Usage:
//   const srv = new FileDataServer(cert, key);
//   const port = await srv.start(filePath, offset);  // resolves once server is bound
//   // send FILE_READY { dataPort: port } to receiver via control channel
//   // receiver connects; transfer streams; 'done' event fires
//
// The server accepts exactly one TLS client, streams the file from `offset` bytes,
// then closes.  Uses the same cert/key as the chat TCPServer so the fingerprint
// pinning check on the receiver side passes.
class FileDataServer extends events.EventEmitter {
  constructor(cert, key) {
    super();
    this._cert   = cert;
    this._key    = key;
    this._server = null;
    this._socket = null;
    this.port    = null;
    this._acceptTimer = null;
  }

  // Open TLS server on 0.0.0.0:0 (OS picks port).
  // Resolves with the bound port number as soon as the server is listening —
  // BEFORE any client connects.  Caller should send FILE_READY immediately.
  //
  // Transfer runs asynchronously from there; events fire on this emitter:
  //   'progress'  (bytesSent, total)
  //   'done'      ()
  //   'error'     (err)
  //
  // Rejects if the server cannot bind, or if no client connects within acceptTimeoutMs.
  start(filePath, offset = 0, acceptTimeoutMs = DEFAULT_ACCEPT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const server = tls.createServer(
        { cert: this._cert, key: this._key, rejectUnauthorized: false },
        (socket) => {
          // Client connected — cancel the accept timeout
          clearTimeout(this._acceptTimer);
          this._acceptTimer = null;
          this._socket = socket;
          socket.setKeepAlive(true);
          socket.on('error', () => {});

          // Stat the file for total-size progress events
          let total;
          try {
            total = fs.statSync(filePath).size;
          } catch (e) {
            socket.destroy();
            server.close();
            this.emit('error', new Error(`Cannot stat file: ${e.message}`));
            return;
          }

          const fileStream = fs.createReadStream(filePath, { start: offset });
          let bytesSent = 0;

          // Manual data pumping — avoids the pipe() + 'data' listener conflict.
          // Backpressure: pause file reads when the socket write buffer is full.
          fileStream.on('data', (chunk) => {
            bytesSent += chunk.length;
            this.emit('progress', offset + bytesSent, total);
            const ok = socket.write(chunk);
            if (!ok) fileStream.pause();
          });

          socket.on('drain', () => fileStream.resume());

          fileStream.on('error', (err) => {
            socket.destroy();
            if (this._server) { this._server.close(); this._server = null; }
            this.emit('error', err);
          });

          fileStream.on('end', () => {
            // Flush the socket write buffer, then send FIN
            socket.end(() => {
              if (this._server) { this._server.close(); this._server = null; }
              this.emit('done');
            });
          });

          // If the receiver closes early (cancel from their side), destroy the read stream
          socket.on('close', () => fileStream.destroy());
        }
      );

      this._server = server;

      server.once('error', (err) => {
        clearTimeout(this._acceptTimer);
        reject(err);
      });

      server.listen(0, '0.0.0.0', () => {
        server.on('error', () => {}); // swallow post-bind errors (same pattern as TCPServer)
        this.port = server.address().port;

        // Start accept timeout — if no client connects, reject
        this._acceptTimer = setTimeout(() => {
          this._acceptTimer = null;
          server.close();
          this._server = null;
          this.emit('error', new Error('Accept timeout: receiver did not connect'));
        }, acceptTimeoutMs);

        resolve(this.port);
      });
    });
  }

  // Stop the transfer immediately: destroy the active socket and close the server.
  cancel() {
    clearTimeout(this._acceptTimer);
    this._acceptTimer = null;
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  // Pause/resume the file stream via TCP flow control.
  // socket.pause() causes the TCP receive window to fill, naturally
  // throttling the sender without closing the connection.
  pause() {
    if (this._socket) this._socket.pause();
  }

  resume() {
    if (this._socket) this._socket.resume();
  }
}

module.exports = FileDataServer;
