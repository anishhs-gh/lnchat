'use strict';

const path = require('path');
const os   = require('os');

const { sendMessage }  = require('../messaging/tcpClient');
const FileDataServer   = require('../messaging/fileDataServer');
const { receiveFile }  = require('../messaging/fileReceiver');
const {
  generateOfferId,
  sha256OfFile,
  formatBytes,
  renderProgressBar,
} = require('../utils/fileUtils');
const logger = require('../utils/logger');

const OFFER_TIMEOUT_MS     = 60_000;  // direct offer expires after 60 s
const BROADCAST_WINDOW_MS  = 10_000;  // broadcast acceptance window
const MAX_PARALLEL_STREAMS = 3;       // max simultaneous broadcast data streams
const PROGRESS_INTERVAL_MS = 500;     // UI refresh rate

class FileTransferManager {
  constructor(peerStore, myId, myNick, myDisc, ui, cert, key, myFingerprint) {
    this._peerStore    = peerStore;
    this._myId         = myId;
    this._myNick       = myNick;
    this._myDisc       = myDisc;
    this._ui           = ui;
    this._cert         = cert;
    this._key          = key;
    this._fingerprint  = myFingerprint;
    this._downloadsDir = path.join(os.homedir(), 'Downloads');

    // ── Outgoing state ────────────────────────────────────────────────────────
    // null | {
    //   offerId, peer, filePath, fileSize, filename, sha256,
    //   status: 'hashing'|'offering'|'waiting_ready'|'transferring'|'paused'|'done'|'cancelled',
    //   dataServer: FileDataServer | null,
    //   bytesSent: number,
    //   offerTimer: Timeout | null,
    //   isBroadcast: bool,
    //   broadcastAccepted: [ { offerId, peer } ],  (populated during acceptance window)
    //   broadcastQueue:    [ { offerId, peer } ],  (waiting for a data slot)
    //   broadcastActive:   [ { offerId, peer, dataServer, bytesSent } ],
    // }
    this._outgoing = null;

    // ── Incoming state ────────────────────────────────────────────────────────
    // Map<offerId, {
    //   from: { id, nickname, discriminator, ip, port, fingerprint },
    //   filename, fileSize, sha256, senderFingerprint,
    //   dataPort: number | null,
    //   status: 'pending'|'queued'|'connecting'|'receiving'|'paused'|'done'|'rejected'|'cancelled',
    //   savePath: string | null,
    //   bytesReceived: number,
    //   receiverHandle: { pause, resume, cancel } | null,
    //   offerTimer: Timeout | null,
    // }>
    this._incomingOffers  = new Map();
    this._activeReceiveId = null;   // offerId of the currently active incoming transfer

    this._progressTimer = null;
  }

  // ── Configuration ────────────────────────────────────────────────────────────

  setDownloadsDir(dir) {
    this._downloadsDir = dir;
  }

  // ── Outgoing — direct offer ───────────────────────────────────────────────────

  async offerFile(peer, filePath) {
    if (this._outgoing) {
      this._ui.print(logger.warn('A file transfer is already in progress. Complete or /cancel it first.'));
      return;
    }

    const fs = require('fs');
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('path is not a regular file');
    } catch (e) {
      this._ui.print(logger.error(`Cannot read file: ${e.message}`));
      return;
    }

    const fileSize = fs.statSync(filePath).size;
    const filename = path.basename(filePath);
    const offerId  = generateOfferId();

    this._outgoing = {
      offerId, peer, filePath, fileSize, filename,
      sha256: null,
      status: 'hashing',
      dataServer: null,
      bytesSent: 0,
      offerTimer: null,
      isBroadcast: false,
      broadcastAccepted: [],
      broadcastQueue: [],
      broadcastActive: [],
    };

    this._ui.print(logger.system(`⏳ Hashing ${filename}…`));
    this._startProgressTimer();

    try {
      this._outgoing.sha256 = await sha256OfFile(filePath);
    } catch (e) {
      this._ui.print(logger.error(`Failed to hash file: ${e.message}`));
      this._outgoing = null;
      this._stopProgressTimer();
      return;
    }
    if (!this._outgoing) return; // cancelled during hashing

    this._outgoing.status = 'offering';

    try {
      await sendMessage(peer.ip, peer.port, {
        type:     'FILE_OFFER',
        offerId,
        from:     { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        filename,
        fileSize,
        sha256:   this._outgoing.sha256,
      }, undefined, peer.fingerprint);
    } catch (e) {
      this._ui.print(logger.error(`Could not reach ${this._tag(peer)}: ${e.message}`));
      this._outgoing = null;
      this._stopProgressTimer();
      return;
    }

    this._ui.print(logger.system(
      `📎 [${offerId}] Offer sent to ${this._tag(peer)} — ${filename} (${formatBytes(fileSize)}). Waiting for response…`
    ));

    this._outgoing.offerTimer = setTimeout(() => {
      if (this._outgoing && this._outgoing.offerId === offerId) {
        this._ui.print(logger.warn(`[${offerId}] Offer to ${this._tag(peer)} timed out.`));
        this._outgoing = null;
        this._stopProgressTimer();
      }
    }, OFFER_TIMEOUT_MS);
  }

  // ── Outgoing — broadcast ───────────────────────────────────────────────────────

  async offerAll(peers, filePath) {
    if (this._outgoing) {
      this._ui.print(logger.warn('A file transfer is already in progress. Complete or /cancel it first.'));
      return;
    }

    const fs = require('fs');
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('path is not a regular file');
    } catch (e) {
      this._ui.print(logger.error(`Cannot read file: ${e.message}`));
      return;
    }

    const fileSize = fs.statSync(filePath).size;
    const filename = path.basename(filePath);

    // Build peer list string for confirmation
    const peerList = peers.map(p => `${this._tag(p)}`).join(', ');
    const answer   = await this._ui.question(
      `Send ${filename} (${formatBytes(fileSize)}) to ${peers.length} peer${peers.length !== 1 ? 's' : ''}: ${peerList}. Proceed? (y/n): `
    );

    if (answer.trim().toLowerCase() !== 'y' && answer.trim().toLowerCase() !== 'yes') {
      this._ui.print(logger.system('Broadcast cancelled.'));
      return;
    }

    this._ui.print(logger.system(`⏳ Hashing ${filename}…`));

    let sha256;
    try {
      sha256 = await sha256OfFile(filePath);
    } catch (e) {
      this._ui.print(logger.error(`Failed to hash file: ${e.message}`));
      return;
    }

    // Assign a unique offer ID per peer
    const perPeerOffers = peers.map(p => ({ offerId: generateOfferId(), peer: p }));

    this._outgoing = {
      offerId: 'broadcast',
      filePath, fileSize, filename, sha256,
      status: 'offering',
      dataServer: null,
      bytesSent: 0,
      offerTimer: null,
      isBroadcast: true,
      broadcastAccepted: [],            // filled during window
      broadcastQueue:    perPeerOffers, // all peers we offered to
      broadcastActive:   [],            // currently streaming
    };

    this._startProgressTimer();

    // Send FILE_OFFER to every peer simultaneously
    await Promise.allSettled(
      perPeerOffers.map(({ offerId, peer }) =>
        sendMessage(peer.ip, peer.port, {
          type:     'FILE_OFFER',
          offerId,
          from:     { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
          filename,
          fileSize,
          sha256,
        }, undefined, peer.fingerprint)
      )
    );

    this._ui.print(logger.system(
      `📡 Broadcast offer sent to ${peers.length} peers. Waiting ${BROADCAST_WINDOW_MS / 1000}s for responses…`
    ));

    // 10-second acceptance window
    this._outgoing.offerTimer = setTimeout(async () => {
      if (!this._outgoing || !this._outgoing.isBroadcast) return;

      const accepted    = this._outgoing.broadcastAccepted;
      const acceptedIds = new Set(accepted.map(e => e.offerId));

      // Send FILE_CANCEL to every peer who did not accept
      for (const { offerId, peer } of perPeerOffers) {
        if (!acceptedIds.has(offerId)) {
          sendMessage(peer.ip, peer.port, {
            type: 'FILE_CANCEL', offerId,
            from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
          }, undefined, peer.fingerprint).catch(() => {});
        }
      }

      if (accepted.length === 0) {
        this._ui.print(logger.warn('No peers accepted the broadcast offer.'));
        this._outgoing = null;
        this._stopProgressTimer();
        return;
      }

      this._ui.print(logger.system(
        `${accepted.length} peer${accepted.length !== 1 ? 's' : ''} accepted. Starting transfer…`
      ));

      // Move accepted peers into the queue, start first batch
      this._outgoing.broadcastQueue  = [...accepted];
      this._outgoing.broadcastActive = [];
      this._outgoing.status          = 'transferring';

      const firstBatch = this._outgoing.broadcastQueue.splice(0, MAX_PARALLEL_STREAMS);
      await Promise.allSettled(firstBatch.map(e => this._startBroadcastStream(e)));
    }, BROADCAST_WINDOW_MS);
  }

  async _startBroadcastStream({ offerId, peer }) {
    if (!this._outgoing || !this._outgoing.isBroadcast) return;

    const { filePath, fileSize, filename } = this._outgoing;
    const dataServer = new FileDataServer(this._cert, this._key);
    const entry      = { offerId, peer, dataServer, bytesSent: 0 };
    this._outgoing.broadcastActive.push(entry);

    let port;
    try {
      port = await dataServer.start(filePath, 0);
    } catch (e) {
      this._ui.print(logger.error(`[${offerId}] Could not open data port for ${this._tag(peer)}: ${e.message}`));
      this._outgoing.broadcastActive = this._outgoing.broadcastActive.filter(a => a.offerId !== offerId);
      this._advanceBroadcastQueue();
      return;
    }

    dataServer.on('progress', (sent) => { entry.bytesSent = sent; });
    dataServer.on('done', () => {
      this._ui.print(logger.system(`✔ [${offerId}] Sent ${filename} to ${this._tag(peer)} (${formatBytes(fileSize)})`));
      this._outgoing.broadcastActive = this._outgoing.broadcastActive.filter(a => a.offerId !== offerId);
      this._advanceBroadcastQueue();
    });
    dataServer.on('error', (err) => {
      this._ui.print(logger.error(`[${offerId}] Transfer to ${this._tag(peer)} failed: ${err.message}`));
      this._outgoing.broadcastActive = this._outgoing.broadcastActive.filter(a => a.offerId !== offerId);
      this._advanceBroadcastQueue();
    });

    try {
      await sendMessage(peer.ip, peer.port, {
        type: 'FILE_READY',
        offerId,
        from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        dataPort:    port,
        fingerprint: this._fingerprint,
      }, undefined, peer.fingerprint);
    } catch (e) {
      dataServer.cancel();
      this._outgoing.broadcastActive = this._outgoing.broadcastActive.filter(a => a.offerId !== offerId);
      this._advanceBroadcastQueue();
    }
  }

  _advanceBroadcastQueue() {
    if (!this._outgoing || !this._outgoing.isBroadcast) return;
    if (this._outgoing.broadcastQueue.length > 0) {
      const next = this._outgoing.broadcastQueue.shift();
      this._startBroadcastStream(next);
    } else if (this._outgoing.broadcastActive.length === 0) {
      this._ui.print(logger.system('📡 Broadcast complete.'));
      this._outgoing = null;
      this._stopProgressTimer();
    }
  }

  // ── Incoming ─────────────────────────────────────────────────────────────────

  async acceptOffer(offerId) {
    const offer = offerId
      ? this._incomingOffers.get(offerId)
      : this._firstPendingOffer();

    if (!offer) {
      this._ui.print(logger.warn(offerId ? `No offer with id [${offerId}].` : 'No pending offers.'));
      return;
    }

    offer.status = 'queued';

    if (this._activeReceiveId === null) {
      await this._startReceive(offer.offerId);
    } else {
      this._ui.print(logger.system(
        `[${offer.offerId}] ${offer.filename} queued — will start after the current transfer.`
      ));
    }
  }

  rejectOffer(offerId) {
    const offer = offerId
      ? this._incomingOffers.get(offerId)
      : this._firstPendingOffer();

    if (!offer) {
      this._ui.print(logger.warn(offerId ? `No offer with id [${offerId}].` : 'No pending offers.'));
      return;
    }

    if (offer.offerTimer) clearTimeout(offer.offerTimer);
    this._incomingOffers.delete(offer.offerId);

    sendMessage(offer.from.ip, offer.from.port, {
      type: 'FILE_REJECT', offerId: offer.offerId,
      from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
    }, undefined, offer.from.fingerprint).catch(() => {});

    this._ui.print(logger.system(
      `[${offer.offerId}] Rejected ${offer.filename} from ${this._tag(offer.from)}.`
    ));
  }

  async _startReceive(offerId) {
    const offer = this._incomingOffers.get(offerId);
    if (!offer) return;

    this._activeReceiveId = offerId;
    offer.status          = 'connecting';

    const { resolveDownloadPath } = require('../utils/fileUtils');
    offer.savePath = resolveDownloadPath(this._downloadsDir, offer.filename);

    // Send FILE_ACCEPT — sender will open a data server and reply with FILE_READY
    try {
      await sendMessage(offer.from.ip, offer.from.port, {
        type: 'FILE_ACCEPT', offerId,
        from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
      }, undefined, offer.from.fingerprint);
    } catch (e) {
      this._ui.print(logger.error(`Could not reach ${this._tag(offer.from)}: ${e.message}`));
      this._incomingOffers.delete(offerId);
      this._activeReceiveId = null;
      this._tryNextQueued();
      return;
    }

    this._ui.print(logger.system(
      `[${offerId}] Accepting ${offer.filename} from ${this._tag(offer.from)} — waiting for data port…`
    ));
    // Actual connection happens in onFileReady() when FILE_READY arrives
  }

  _connectToDataPort(offerId) {
    const offer = this._incomingOffers.get(offerId);
    if (!offer || offer.dataPort == null) return;

    offer.status = 'receiving';
    const offset = offer.bytesReceived || 0;

    this._startProgressTimer();

    const handle = receiveFile(
      offer.from.ip,
      offer.dataPort,
      offer.senderFingerprint,
      offer.savePath,
      offset,
      (total) => { offer.bytesReceived = total; }
    );

    offer.receiverHandle = handle;

    handle.promise.then(({ bytesReceived, sha256 }) => {
      // Clear progress BEFORE printing so ✔ message appears without a progress redraw+erase flicker
      offer.status = 'done';
      this._incomingOffers.delete(offerId);
      this._activeReceiveId = null;
      this._stopProgressTimer();

      if (sha256 !== offer.sha256) {
        this._ui.print(logger.error(
          `⚠ [${offerId}] ${offer.filename} failed integrity check — file deleted. Ask sender to retry.`
        ));
        try { require('fs').unlinkSync(offer.savePath); } catch (_) {}
      } else {
        this._ui.print(logger.system(
          `✔ [${offerId}] Received ${offer.filename} (${formatBytes(bytesReceived)}) → ${offer.savePath}`
        ));
      }
      this._tryNextQueued();
    }).catch((err) => {
      offer.status = 'cancelled';
      this._incomingOffers.delete(offerId);
      this._activeReceiveId = null;
      this._stopProgressTimer();
      if (err.message !== 'cancelled') {
        this._ui.print(logger.error(`[${offerId}] Transfer failed: ${err.message}`));
      }
      this._tryNextQueued();
    });
  }

  _tryNextQueued() {
    for (const [id, offer] of this._incomingOffers) {
      if (offer.status === 'queued') {
        this._startReceive(id);
        return;
      }
    }
  }

  // ── Cancel / Pause / Resume ───────────────────────────────────────────────────

  cancel(offerId) {
    const id = offerId ? offerId.trim() : undefined;
    if (id) {
      this._cancelById(id);
      return;
    }

    const hasOut = this._outgoing &&
      ['hashing', 'offering', 'waiting_ready', 'transferring', 'paused'].includes(this._outgoing.status);
    const hasIn  = this._activeReceiveId !== null;

    if (hasOut && hasIn) {
      const outId = this._outgoing.isBroadcast ? 'broadcast' : this._outgoing.offerId;
      const inOff = this._incomingOffers.get(this._activeReceiveId);
      this._ui.print(logger.warn(
        `Active transfers: [${outId}] outgoing | [${this._activeReceiveId}] ` +
        `incoming ← ${inOff ? this._tag(inOff.from) : '?'}. Use /cancel <id>.`
      ));
      return;
    }
    if (hasOut) { this._cancelOutgoing(); return; }
    if (hasIn)  { this._cancelIncoming(this._activeReceiveId); return; }
    this._ui.print(logger.warn('No active transfer to cancel.'));
  }

  _cancelById(id) {
    if (this._outgoing) {
      if (!this._outgoing.isBroadcast && this._outgoing.offerId === id) {
        this._cancelOutgoing();
        return;
      }
      if (this._outgoing.isBroadcast) {
        const active = this._outgoing.broadcastActive.find(a => a.offerId === id);
        if (active) { this._cancelBroadcastStream(id); return; }
        // Also check if it's the whole broadcast
        if (id === 'broadcast') { this._cancelOutgoing(); return; }
      }
    }
    if (this._incomingOffers.has(id)) {
      this._cancelIncoming(id);
      return;
    }
    this._ui.print(logger.warn(`No transfer with id [${id}].`));
  }

  _cancelOutgoing() {
    if (!this._outgoing) return;
    const { offerId, peer, filename, dataServer, isBroadcast, broadcastActive, broadcastQueue, offerTimer } = this._outgoing;

    if (offerTimer) clearTimeout(offerTimer);

    if (isBroadcast) {
      for (const a of broadcastActive) {
        if (a.dataServer) a.dataServer.cancel();
        sendMessage(a.peer.ip, a.peer.port, {
          type: 'FILE_CANCEL', offerId: a.offerId,
          from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        }, undefined, a.peer.fingerprint).catch(() => {});
      }
      for (const q of broadcastQueue) {
        sendMessage(q.peer.ip, q.peer.port, {
          type: 'FILE_CANCEL', offerId: q.offerId,
          from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        }, undefined, q.peer.fingerprint).catch(() => {});
      }
      this._ui.print(logger.system('📡 Broadcast cancelled.'));
    } else {
      if (dataServer) dataServer.cancel();
      if (peer) {
        sendMessage(peer.ip, peer.port, {
          type: 'FILE_CANCEL', offerId,
          from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        }, undefined, peer.fingerprint).catch(() => {});
      }
      this._ui.print(logger.system(`[${offerId}] Transfer of ${filename} cancelled.`));
    }

    this._outgoing = null;
    this._stopProgressTimer();
  }

  _cancelBroadcastStream(offerId) {
    if (!this._outgoing || !this._outgoing.isBroadcast) return;
    const active = this._outgoing.broadcastActive.find(a => a.offerId === offerId);
    if (!active) return;
    if (active.dataServer) active.dataServer.cancel();
    sendMessage(active.peer.ip, active.peer.port, {
      type: 'FILE_CANCEL', offerId,
      from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
    }, undefined, active.peer.fingerprint).catch(() => {});
    this._outgoing.broadcastActive = this._outgoing.broadcastActive.filter(a => a.offerId !== offerId);
    this._ui.print(logger.system(`[${offerId}] Cancelled transfer to ${this._tag(active.peer)}.`));
    this._advanceBroadcastQueue();
  }

  _cancelIncoming(offerId) {
    const offer = this._incomingOffers.get(offerId);
    if (!offer) return;
    if (offer.offerTimer) clearTimeout(offer.offerTimer);
    if (offer.receiverHandle) offer.receiverHandle.cancel();

    const wasActive = this._activeReceiveId === offerId;
    this._incomingOffers.delete(offerId);
    if (wasActive) {
      this._activeReceiveId = null;
      this._stopProgressTimer();
      this._tryNextQueued();
    }

    sendMessage(offer.from.ip, offer.from.port, {
      type: 'FILE_CANCEL', offerId,
      from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
    }, undefined, offer.from.fingerprint).catch(() => {});

    this._ui.print(logger.system(`[${offerId}] Incoming transfer of ${offer.filename} cancelled.`));
  }

  pause(offerId) {
    const target = this._resolveActiveTransfer(offerId, 'pause');
    if (!target) return;

    if (target.type === 'outgoing') {
      if (!this._outgoing || this._outgoing.status !== 'transferring') {
        this._ui.print(logger.warn('Transfer is not currently active.'));
        return;
      }
      this._outgoing.status = 'paused';

      if (this._outgoing.isBroadcast) {
        const active = this._outgoing.broadcastActive.find(a => a.offerId === offerId);
        if (active && active.dataServer) active.dataServer.pause();
        const id = offerId || (this._outgoing.broadcastActive[0] || {}).offerId;
        const p  = active ? active.peer : null;
        if (p) {
          sendMessage(p.ip, p.port, {
            type: 'FILE_PAUSE', offerId: id,
            from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
          }, undefined, p.fingerprint).catch(() => {});
        }
        this._ui.print(logger.system(`[${id}] Transfer paused.`));
      } else {
        if (this._outgoing.dataServer) this._outgoing.dataServer.pause();
        sendMessage(this._outgoing.peer.ip, this._outgoing.peer.port, {
          type: 'FILE_PAUSE', offerId: this._outgoing.offerId,
          from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        }, undefined, this._outgoing.peer.fingerprint).catch(() => {});
        this._ui.print(logger.system(`[${this._outgoing.offerId}] Transfer paused.`));
      }
    } else {
      const offer = this._incomingOffers.get(target.offerId);
      if (!offer || offer.status !== 'receiving') {
        this._ui.print(logger.warn('Transfer is not currently active.'));
        return;
      }
      offer.status = 'paused';
      if (offer.receiverHandle) offer.receiverHandle.pause();
      sendMessage(offer.from.ip, offer.from.port, {
        type: 'FILE_PAUSE', offerId: target.offerId,
        from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
      }, undefined, offer.from.fingerprint).catch(() => {});
      this._ui.print(logger.system(`[${target.offerId}] Transfer paused.`));
    }
  }

  async resume(offerId) {
    const target = this._resolveActiveTransfer(offerId, 'resume');
    if (!target) return;

    if (target.type === 'outgoing') {
      if (!this._outgoing || this._outgoing.status !== 'paused') {
        this._ui.print(logger.warn('Transfer is not paused.'));
        return;
      }
      // Sender-initiated resume: send FILE_RESUME_REQUEST; receiver auto-responds
      // with FILE_RESUME, then we open a new data port in onFileResume().
      const id   = this._outgoing.isBroadcast ? offerId : this._outgoing.offerId;
      const peer = this._outgoing.isBroadcast
        ? (this._outgoing.broadcastActive.find(a => a.offerId === id) || {}).peer
        : this._outgoing.peer;

      if (peer) {
        try {
          await sendMessage(peer.ip, peer.port, {
            type: 'FILE_RESUME_REQUEST', offerId: id,
            from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
          }, undefined, peer.fingerprint);
          this._ui.print(logger.system(`[${id}] Resume requested — waiting for receiver…`));
        } catch (e) {
          this._ui.print(logger.error(`Could not reach ${this._tag(peer)}: ${e.message}`));
        }
      }
    } else {
      const offer = this._incomingOffers.get(target.offerId);
      if (!offer || offer.status !== 'paused') {
        this._ui.print(logger.warn('Transfer is not paused.'));
        return;
      }
      // Receiver-initiated resume: send FILE_RESUME with byte offset
      try {
        await sendMessage(offer.from.ip, offer.from.port, {
          type: 'FILE_RESUME', offerId: target.offerId,
          from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
          bytesReceived: offer.bytesReceived || 0,
        }, undefined, offer.from.fingerprint);
        this._ui.print(logger.system(`[${target.offerId}] Resume sent — reconnecting…`));
      } catch (e) {
        this._ui.print(logger.error(`Could not reach sender: ${e.message}`));
      }
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────────

  listTransfers() {
    const lines = ['Transfers:'];
    let any = false;

    if (this._outgoing) {
      any = true;
      const o = this._outgoing;

      if (o.isBroadcast) {
        for (const a of o.broadcastActive) {
          const pct = o.fileSize > 0 ? a.bytesSent / o.fileSize : 0;
          lines.push(`  ⬆ [${a.offerId}] ${o.filename} → ${this._tag(a.peer)}   ${formatBytes(a.bytesSent)} / ${formatBytes(o.fileSize)}  ${Math.round(pct * 100)}%`);
        }
        for (const q of o.broadcastQueue) {
          lines.push(`  ⏳ [${q.offerId}] ${o.filename} → ${this._tag(q.peer)}   queued (slot waiting)`);
        }
      } else {
        const pct   = o.fileSize > 0 ? o.bytesSent / o.fileSize : 0;
        const label = o.status === 'paused'   ? '(paused)' :
                      o.status === 'offering'  ? '(waiting for response)' :
                      o.status === 'hashing'   ? '(hashing…)' :
                      `${Math.round(pct * 100)}%`;
        lines.push(`  ⬆ [${o.offerId}] ${o.filename} → ${this._tag(o.peer)}   ${label}`);
      }
    }

    for (const [id, offer] of this._incomingOffers) {
      any = true;
      const { status, filename, from, bytesReceived, fileSize } = offer;
      if (status === 'receiving') {
        const pct = fileSize > 0 ? (bytesReceived || 0) / fileSize : 0;
        lines.push(`  ⬇ [${id}] ${filename} ← ${this._tag(from)}   receiving  ${formatBytes(bytesReceived || 0)} / ${formatBytes(fileSize)}  ${Math.round(pct * 100)}%`);
      } else if (status === 'paused') {
        lines.push(`  ⏸ [${id}] ${filename} ← ${this._tag(from)}   paused  ${formatBytes(bytesReceived || 0)} / ${formatBytes(fileSize)}`);
      } else if (status === 'queued') {
        lines.push(`  ⏳ [${id}] ${filename} ← ${this._tag(from)}   queued (accepted, waiting)`);
      } else if (status === 'pending') {
        lines.push(`  📎 [${id}] ${filename} ← ${this._tag(from)}   pending  —  \x1b[36m/accept ${id}\x1b[0m or \x1b[36m/reject ${id}\x1b[0m`);
      }
    }

    if (!any) lines.push('  No active transfers.');
    return lines.join('\n');
  }

  getProgressLines() {
    const lines = [];

    if (this._outgoing && ['transferring', 'paused'].includes(this._outgoing.status)) {
      const o = this._outgoing;
      if (o.isBroadcast) {
        for (const a of o.broadcastActive) {
          const pct = o.fileSize > 0 ? a.bytesSent / o.fileSize : 0;
          const bar = renderProgressBar(pct);
          lines.push(
            `⬆ [${a.offerId}] ${o.filename} → ${a.peer.nickname}#${a.peer.discriminator}` +
            `   [${bar}]  ${Math.round(pct * 100)}%  ${formatBytes(a.bytesSent)} / ${formatBytes(o.fileSize)}`
          );
        }
      } else if (o.dataServer) {
        const pct   = o.fileSize > 0 ? o.bytesSent / o.fileSize : 0;
        const bar   = renderProgressBar(pct);
        const label = o.status === 'paused' ? '  (paused)' : '';
        lines.push(
          `⬆ [${o.offerId}] ${o.filename} → ${o.peer.nickname}#${o.peer.discriminator}` +
          `   [${bar}]  ${Math.round(pct * 100)}%  ${formatBytes(o.bytesSent)} / ${formatBytes(o.fileSize)}${label}`
        );
      }
    }

    if (this._activeReceiveId) {
      const offer = this._incomingOffers.get(this._activeReceiveId);
      if (offer && ['receiving', 'paused'].includes(offer.status)) {
        const pct   = offer.fileSize > 0 ? (offer.bytesReceived || 0) / offer.fileSize : 0;
        const bar   = renderProgressBar(pct);
        const label = offer.status === 'paused' ? '  (paused)' : '';
        lines.push(
          `⬇ [${this._activeReceiveId}] ${offer.filename} ← ${offer.from.nickname}#${offer.from.discriminator}` +
          `   [${bar}]  ${Math.round(pct * 100)}%  ${formatBytes(offer.bytesReceived || 0)} / ${formatBytes(offer.fileSize)}${label}`
        );
      }
    }

    return lines;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────────

  peerLeft(peer) {
    if (this._outgoing && !this._outgoing.isBroadcast && this._outgoing.peer.id === peer.id) {
      this._ui.print(logger.warn(`[${this._outgoing.offerId}] ${peer.nickname} went offline — transfer cancelled.`));
      this._cancelOutgoing();
    }
    for (const [id, offer] of this._incomingOffers) {
      if (offer.from.id === peer.id) {
        this._ui.print(logger.warn(`[${id}] ${peer.nickname} went offline — transfer cancelled.`));
        this._cancelIncoming(id);
      }
    }
  }

  cancelAll() {
    if (this._outgoing) this._cancelOutgoing();
    for (const id of [...this._incomingOffers.keys()]) {
      this._cancelIncoming(id);
    }
    this._stopProgressTimer();
  }

  // ── TCPServer callbacks ─────────────────────────────────────────────────────────

  onFileOffer(msg) {
    const { offerId, from, filename, fileSize, sha256 } = msg;
    if (this._incomingOffers.has(offerId)) return;

    // Enrich `from` with IP/port from peerStore for outgoing control messages
    const peerEntry = this._peerStore.get(from.id);
    const sender    = peerEntry
      ? { ...from, ip: peerEntry.ip, port: peerEntry.port, fingerprint: peerEntry.fingerprint }
      : from;

    const offer = {
      offerId,                                   // stored here so offer.offerId works everywhere
      from:              sender,
      filename,
      fileSize,
      sha256,
      senderFingerprint: sender.fingerprint || null,
      dataPort:          null,
      status:            'pending',
      savePath:          null,
      bytesReceived:     0,
      receiverHandle:    null,
      offerTimer:        setTimeout(() => {
        if (this._incomingOffers.has(offerId) &&
            this._incomingOffers.get(offerId).status === 'pending') {
          this._ui.print(logger.warn(`[${offerId}] Offer from ${sender.nickname} expired.`));
          this._incomingOffers.delete(offerId);
        }
      }, OFFER_TIMEOUT_MS),
    };

    this._incomingOffers.set(offerId, offer);

    const disc = from.discriminator ? logger.dim('#' + from.discriminator) : '';
    this._ui.print(
      `📎 [${offerId}] ${logger.colorize(from.nickname)}${disc} wants to send ` +
      `${filename} (${formatBytes(fileSize)}).` +
      `  \x1b[36m/accept ${offerId}\x1b[0m  or  \x1b[36m/reject ${offerId}\x1b[0m`
    );
  }

  onFileAccept(msg) {
    const { offerId } = msg;
    if (!this._outgoing) return;

    if (this._outgoing.isBroadcast) {
      // Record acceptance during the window; _openDataPortAndSendReady is called later
      const entry = (this._outgoing.broadcastQueue || []).find(e => e.offerId === offerId) ||
                    (this._outgoing.broadcastAccepted || []).find(e => e.offerId === offerId);
      if (entry && !this._outgoing.broadcastAccepted.find(e => e.offerId === offerId)) {
        this._outgoing.broadcastAccepted.push(entry);
      }
      return;
    }

    if (this._outgoing.offerId !== offerId) return;
    if (this._outgoing.offerTimer) { clearTimeout(this._outgoing.offerTimer); this._outgoing.offerTimer = null; }

    this._outgoing.status = 'waiting_ready';
    this._ui.print(logger.system(`[${offerId}] ${this._tag(this._outgoing.peer)} accepted. Opening data port…`));
    this._openDataPortAndSendReady(offerId, this._outgoing.peer, 0);
  }

  async _openDataPortAndSendReady(offerId, peer, offset) {
    if (!this._outgoing || this._outgoing.offerId !== offerId) return;

    const { filePath, fileSize, filename } = this._outgoing;
    const dataServer = new FileDataServer(this._cert, this._key);
    this._outgoing.dataServer = dataServer;

    let port;
    try {
      port = await dataServer.start(filePath, offset);
    } catch (e) {
      this._ui.print(logger.error(`[${offerId}] Failed to open data port: ${e.message}`));
      if (this._outgoing && this._outgoing.offerId === offerId) {
        this._outgoing = null;
        this._stopProgressTimer();
      }
      return;
    }

    if (!this._outgoing || this._outgoing.offerId !== offerId) {
      dataServer.cancel();
      return;
    }

    dataServer.on('progress', (sent) => {
      if (this._outgoing && this._outgoing.offerId === offerId) this._outgoing.bytesSent = sent;
    });

    dataServer.on('done', () => {
      if (this._outgoing && this._outgoing.offerId === offerId) {
        this._outgoing = null;
        this._stopProgressTimer();   // clears progress BEFORE printing so no redraw+erase flicker
      }
      this._ui.print(logger.system(
        `✔ [${offerId}] Sent ${filename} to ${this._tag(peer)} (${formatBytes(fileSize)})`
      ));
    });

    dataServer.on('error', (err) => {
      if (this._outgoing && this._outgoing.offerId === offerId) {
        this._outgoing = null;
        this._stopProgressTimer();
      }
      this._ui.print(logger.error(`[${offerId}] Transfer failed: ${err.message}`));
    });

    this._outgoing.status = 'transferring';

    try {
      await sendMessage(peer.ip, peer.port, {
        type: 'FILE_READY', offerId,
        from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        dataPort:    port,
        fingerprint: this._fingerprint,
      }, undefined, peer.fingerprint);
    } catch (e) {
      dataServer.cancel();
      this._ui.print(logger.error(`[${offerId}] Could not send FILE_READY: ${e.message}`));
      if (this._outgoing && this._outgoing.offerId === offerId) {
        this._outgoing = null;
        this._stopProgressTimer();
      }
    }
  }

  onFileReject(msg) {
    const { offerId } = msg;
    if (!this._outgoing || this._outgoing.offerId !== offerId) return;
    if (this._outgoing.offerTimer) clearTimeout(this._outgoing.offerTimer);
    this._ui.print(logger.warn(`[${offerId}] ${this._tag(this._outgoing.peer)} declined the file.`));
    this._outgoing = null;
    this._stopProgressTimer();
  }

  onFileReady(msg) {
    // Receiver side: sender opened the data port, now connect to it
    const { offerId, dataPort, fingerprint } = msg;
    const offer = this._incomingOffers.get(offerId);
    if (!offer) return;
    offer.dataPort          = dataPort;
    offer.senderFingerprint = fingerprint || offer.senderFingerprint;
    this._connectToDataPort(offerId);
  }

  onFileCancel(msg) {
    const { offerId } = msg;

    if (this._outgoing) {
      if (!this._outgoing.isBroadcast && this._outgoing.offerId === offerId) {
        if (this._outgoing.dataServer) this._outgoing.dataServer.cancel();
        if (this._outgoing.offerTimer) clearTimeout(this._outgoing.offerTimer);
        this._ui.print(logger.warn(`[${offerId}] Transfer cancelled by peer.`));
        this._outgoing = null;
        this._stopProgressTimer();
        return;
      }
      if (this._outgoing.isBroadcast) {
        this._cancelBroadcastStream(offerId);
        return;
      }
    }

    const offer = this._incomingOffers.get(offerId);
    if (offer) {
      if (offer.offerTimer) clearTimeout(offer.offerTimer);
      if (offer.receiverHandle) offer.receiverHandle.cancel();
      this._incomingOffers.delete(offerId);
      if (this._activeReceiveId === offerId) {
        this._activeReceiveId = null;
        this._stopProgressTimer();
        this._tryNextQueued();
      }
      this._ui.print(logger.warn(`[${offerId}] ${offer.filename} — cancelled by sender.`));
    }
  }

  onFilePause(msg) {
    const { offerId } = msg;

    // Remote side paused outgoing (means we're the receiver and they stopped sending)
    const incoming = this._incomingOffers.get(offerId);
    if (incoming && incoming.status === 'receiving') {
      incoming.status = 'paused';
      if (incoming.receiverHandle) incoming.receiverHandle.pause();
      this._ui.print(logger.system(`[${offerId}] Transfer paused by sender.`));
      return;
    }

    // Remote side paused incoming (means we're the sender and they asked us to stop)
    if (this._outgoing && this._outgoing.offerId === offerId && this._outgoing.status === 'transferring') {
      this._outgoing.status = 'paused';
      if (this._outgoing.dataServer) this._outgoing.dataServer.pause();
      this._ui.print(logger.system(`[${offerId}] Transfer paused by receiver.`));
    }
  }

  async onFileResume(msg) {
    // Receiver sent FILE_RESUME — open a new data port from the given offset
    const { offerId, bytesReceived } = msg;
    if (!this._outgoing || this._outgoing.offerId !== offerId) return;

    this._outgoing.status     = 'transferring';
    this._outgoing.dataServer = null; // old server closed or cancelled
    this._ui.print(logger.system(`[${offerId}] Resuming from ${formatBytes(bytesReceived)}…`));
    await this._openDataPortAndSendReady(offerId, this._outgoing.peer, bytesReceived);
  }

  onFileResumeRequest(msg) {
    // Sender wants to resume — auto-reply with FILE_RESUME so they can open data port
    const { offerId } = msg;
    const offer = this._incomingOffers.get(offerId);
    if (!offer || offer.status !== 'paused') return;

    sendMessage(offer.from.ip, offer.from.port, {
      type: 'FILE_RESUME', offerId,
      from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
      bytesReceived: offer.bytesReceived || 0,
    }, undefined, offer.from.fingerprint).catch(() => {});
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  _tag(peer) {
    const disc = peer.discriminator || peer.disc || '';
    return `${logger.colorize(peer.nickname || '')}${disc ? logger.dim('#' + disc) : ''}`;
  }

  _firstPendingOffer() {
    for (const offer of this._incomingOffers.values()) {
      if (offer.status === 'pending') return offer;
    }
    return null;
  }

  // Resolve which active transfer the user is referring to.
  // Returns { type: 'outgoing'|'incoming', offerId } or null on ambiguity/not found.
  _resolveActiveTransfer(offerId, action) {
    const id = offerId ? offerId.trim() : undefined;

    if (id) {
      if (this._outgoing) {
        if (!this._outgoing.isBroadcast && this._outgoing.offerId === id)
          return { type: 'outgoing', offerId: id };
        if (this._outgoing.isBroadcast && this._outgoing.broadcastActive.find(a => a.offerId === id))
          return { type: 'outgoing', offerId: id };
      }
      if (this._incomingOffers.has(id)) return { type: 'incoming', offerId: id };
      this._ui.print(logger.warn(`No active transfer with id [${id}].`));
      return null;
    }

    const hasOut = this._outgoing &&
      ['transferring', 'paused'].includes(this._outgoing.status);
    const inOffer = this._activeReceiveId ? this._incomingOffers.get(this._activeReceiveId) : null;
    const hasIn   = inOffer && ['receiving', 'paused'].includes(inOffer.status);

    if (hasOut && hasIn) {
      const outId = this._outgoing.isBroadcast ? 'broadcast' : this._outgoing.offerId;
      this._ui.print(logger.warn(
        `Active transfers: [${outId}] outgoing | [${this._activeReceiveId}] ← ${this._tag(inOffer.from)}. ` +
        `Use /${action} <id>.`
      ));
      return null;
    }
    if (hasOut) return { type: 'outgoing', offerId: this._outgoing.isBroadcast ? 'broadcast' : this._outgoing.offerId };
    if (hasIn)  return { type: 'incoming', offerId: this._activeReceiveId };
    this._ui.print(logger.warn(`No active transfer to ${action}.`));
    return null;
  }

  _startProgressTimer() {
    if (this._progressTimer) return;
    this._progressTimer = setInterval(() => {
      const lines = this.getProgressLines();
      if (lines.length > 0) this._ui.updateProgress(lines);
    }, PROGRESS_INTERVAL_MS);
  }

  _stopProgressTimer() {
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
    this._ui.clearProgress();
  }
}

module.exports = FileTransferManager;
