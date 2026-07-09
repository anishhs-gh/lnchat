'use strict';

const { sendMessage, sendPing } = require('../messaging/tcpClient');
const { parseFilePath }          = require('../utils/fileUtils');
const logger = require('../utils/logger');

const HELP_TEXT = `
Commands:
  /list                  List discovered devices
  /msg <name> [msg]      Send a message (omit [msg] to be prompted)
  /ping <name>           Ping a peer and show round-trip time
  /focus <name>          Enter focused chat with a peer (all text goes to them)
  /back                  Exit focused chat and return to global prompt
  /all <msg>             Broadcast a message to all online peers
  /history [name]        Show recent message history (optionally filtered by peer)
  /notify                Toggle desktop notifications on/off
  /clear                 Clear the terminal screen (local only)
  /help                  Show this help
  /exit                  Quit

File transfer:
  /share <name> <file>   Offer a file to a peer (drag file into terminal to paste path)
  /share <file>          Offer to focused peer (in focus mode)
  /share all <file>      Broadcast offer to all peers (confirmation required)
  /accept [id]           Accept an incoming file offer (id optional if only one pending)
  /reject [id]           Decline a file offer
  /cancel [id]           Cancel active transfer (id required if ambiguous)
  /pause  [id]           Pause active transfer
  /resume [id]           Resume paused transfer
  /transfers             Show all active, queued, and pending transfers
  /downloads [path]      Show or set the download directory

Voice calls:
  /call <name>           Start a voice call with a peer
  /answer                Answer an incoming call
  /reject                Decline an incoming call
  /mute                  Toggle your microphone during a call
  /echo                  Toggle acoustic echo cancellation (on by default)
  /hangup                End the current call
`.trim();

class Commands {
  // notifyState: shared object { enabled: bool } — mutated here, read by index.js
  constructor(peerStore, deviceId, nickname, discriminator, ui, history, notifyState) {
    this.peerStore     = peerStore;
    this.deviceId      = deviceId;
    this.nickname      = nickname;
    this.discriminator = discriminator;
    this.ui            = ui;
    this.history       = history;
    this._notifyState  = notifyState;

    this._pendingTarget        = null;  // one-shot: next plain line goes to this peer
    this._focusTarget          = null;  // sticky: all plain lines go to this peer
    this._lastTypingSent       = 0;     // debounce timestamp for outgoing TYPING packets
    this._stopTypingTimer      = null;  // fires STOP_TYPING after 3s of no keypresses
    this.fileManager           = null;  // set by index.js after construction
    this.callManager           = null;  // set by index.js after construction
    this._onDownloadsDirChange = null;  // set by index.js to persist changes to profile

    // Send typing indicators to the focused peer on keypress
    ui.onKeypress(() => this._sendTypingIndicator());
  }

  async handle(input) {
    const trimmed = input.trim();

    // One-shot pending mode: if a plain line arrives, send it then clear
    if (this._pendingTarget) {
      const peer = this._pendingTarget;
      this._pendingTarget = null;
      if (trimmed && !trimmed.startsWith('/')) {
        await this._sendTo(peer, trimmed);
        return;
      }
      // Command typed while pending → cancel pending, fall through to command
    }

    if (!trimmed) return;

    // Focus (sticky) mode: non-command input goes to the focused peer
    if (this._focusTarget && !trimmed.startsWith('/')) {
      await this._sendTo(this._focusTarget, trimmed);
      return;
    }

    if (trimmed === '/list') {
      this._list();
    } else if (trimmed.startsWith('/msg ') || trimmed === '/msg') {
      await this._msg(trimmed.slice(4).trim());
    } else if (trimmed.startsWith('/ping ') || trimmed === '/ping') {
      await this._ping(trimmed.slice(5).trim());
    } else if (trimmed.startsWith('/focus ') || trimmed === '/focus') {
      this._focus(trimmed.slice(6).trim());
    } else if (trimmed === '/back') {
      this._back();
    } else if (trimmed.startsWith('/all ') || trimmed === '/all') {
      await this._all(trimmed.slice(4).trim());
    } else if (trimmed.startsWith('/history ') || trimmed === '/history') {
      this._history(trimmed.slice(8).trim());
    } else if (trimmed === '/notify') {
      this._toggleNotify();
    } else if (trimmed === '/clear') {
      this._clear();
    } else if (trimmed === '/help') {
      this.ui.print(HELP_TEXT);
    } else if (trimmed === '/exit') {
      this.ui.print('Goodbye!');
      process.exit(0);
    } else if (trimmed.startsWith('/share')) {
      await this._share(trimmed.slice(6).trim());
    } else if (trimmed.startsWith('/accept')) {
      await this._accept(trimmed.slice(7).trim());
    } else if (trimmed.startsWith('/call ') || trimmed === '/call') {
      await this._call(trimmed.slice(5).trim());
    } else if (trimmed === '/answer') {
      if (this.callManager) this.callManager.answer();
    } else if (trimmed === '/hangup') {
      if (this.callManager) this.callManager.hangup();
    } else if (trimmed === '/mute') {
      if (this.callManager) this.callManager.toggleMute();
    } else if (trimmed === '/echo') {
      if (this.callManager) this.callManager.toggleEcho();
    } else if (trimmed.startsWith('/reject')) {
      // A ringing call takes priority over a pending file offer.
      if (this.callManager && this.callManager.hasIncomingCall()) {
        this.callManager.reject();
      } else {
        this._reject(trimmed.slice(7).trim());
      }
    } else if (trimmed.startsWith('/cancel')) {
      this._cancel(trimmed.slice(7).trim());
    } else if (trimmed.startsWith('/pause')) {
      this._pause(trimmed.slice(6).trim());
    } else if (trimmed.startsWith('/resume')) {
      await this._resume(trimmed.slice(7).trim());
    } else if (trimmed === '/transfers') {
      this._transfers();
    } else if (trimmed.startsWith('/downloads')) {
      await this._downloads(trimmed.slice(10).trim());
    } else if (trimmed.startsWith('/')) {
      this.ui.print(logger.warn(`Unknown command "${trimmed}". Type /help for help.`));
    } else {
      this.ui.print(logger.warn('Type /help to see available commands.'));
    }
  }

  // Called by index.js when a peer leaves — auto-exits focus if it was that peer
  peerLeft(peer) {
    if (this._focusTarget && this._focusTarget.id === peer.id) {
      this._cancelStopTyping();
      this.ui.print(logger.system(`${this._tag(peer)} went offline. Exiting focus mode.`));
      this._focusTarget = null;
      this.ui.setPrompt('> ');
    }
    if (this.fileManager) this.fileManager.peerLeft(peer);
    if (this.callManager) this.callManager.peerLeft(peer);
  }

  // ── /list ────────────────────────────────────────────────────────────────────

  _list() {
    const peers = this.peerStore.list();
    if (peers.length === 0) {
      this.ui.print('No peers discovered yet. They will appear automatically.');
      return;
    }
    const lines = ['Available devices:\n'];
    peers.forEach((p, i) => {
      const latency = p.latency != null ? `  ${p.latency}ms` : '';
      lines.push(`  ${i + 1}. ${this._tag(p)}  ${p.ip}${latency}`);
    });
    this.ui.print(lines.join('\n'));
  }

  // ── /msg ─────────────────────────────────────────────────────────────────────

  async _msg(args) {
    if (!args) {
      this.ui.print(logger.warn('Usage: /msg <nickname> [message]'));
      return;
    }

    const spaceIdx    = args.indexOf(' ');
    const targetName  = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
    const messageText = spaceIdx === -1 ? ''   : args.slice(spaceIdx + 1).trim();

    const peer = this._resolvePeer(targetName);
    if (!peer) return;

    if (messageText) {
      await this._sendTo(peer, messageText);
    } else {
      this._pendingTarget = peer;
      this.ui.print(`Messaging ${this._tag(peer)} — type your message:`);
    }
  }

  // ── /ping ────────────────────────────────────────────────────────────────────

  async _ping(name) {
    if (!name) {
      this.ui.print(logger.warn('Usage: /ping <nickname>'));
      return;
    }

    const peer = this._resolvePeer(name);
    if (!peer) return;

    try {
      const ms = await sendPing(peer.ip, peer.port, undefined, peer.fingerprint);
      this.peerStore.updateLatency(peer.id, ms);
      this.ui.print(`pong from ${this._tag(peer)} (${ms}ms)`);
    } catch (e) {
      this.ui.print(logger.error(`Ping failed for ${this._tag(peer)}: ${e.message}`));
    }
  }

  // ── /all ─────────────────────────────────────────────────────────────────────

  async _all(text) {
    if (!text) {
      this.ui.print(logger.warn('Usage: /all <message>'));
      return;
    }
    const peers = this.peerStore.list();
    if (peers.length === 0) {
      this.ui.print('No peers online to broadcast to.');
      return;
    }
    // Overwrite the readline echo immediately — before any await — so the
    // cursor is still directly below the input line when printSent() runs.
    const n = peers.length;
    this.ui.printSent(
      `${logger.timestamp()} ${logger.colorize('You')} → all (${n} peer${n !== 1 ? 's' : ''}): ${text}`
    );
    const results = await Promise.allSettled(
      peers.map(p => sendMessage(p.ip, p.port, {
        type:    'MESSAGE',
        from:    { id: this.deviceId, nickname: this.nickname, discriminator: this.discriminator },
        message: text,
      }, undefined, p.fingerprint))
    );
    let failed = 0;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        this.history.addOutgoing(peers[i].id, peers[i].nickname, peers[i].discriminator, text);
      } else {
        failed++;
      }
    });
    if (failed > 0) {
      this.ui.print(logger.warn(`/all: ${failed} of ${n} peer(s) unreachable`));
    }
  }

  // ── /history ─────────────────────────────────────────────────────────────────

  _history(name) {
    const entries = name ? this.history.getByNickname(name) : this.history.getRecent(20);
    if (entries.length === 0) {
      const msg = name ? `No history with "${name}".` : 'No message history yet.';
      this.ui.print(msg);
      return;
    }
    const header = name ? `History with ${name}:\n` : 'Recent messages:\n';
    const lines  = [header];
    for (const e of entries) {
      const t    = new Date(e.timestamp);
      const h    = t.getHours().toString().padStart(2, '0');
      const m    = t.getMinutes().toString().padStart(2, '0');
      const ts   = `\x1b[2m[${h}:${m}]\x1b[0m`;
      const tag  = `${logger.colorize(e.peerNickname)}\x1b[2m#${e.peerDisc}\x1b[0m`;
      if (e.outgoing) {
        lines.push(`  ${ts} ${logger.colorize('You')} → ${tag}: ${e.message}`);
      } else {
        lines.push(`  ${ts} ${tag}: ${e.message}`);
      }
    }
    this.ui.print(lines.join('\n'));
  }

  // ── /focus ───────────────────────────────────────────────────────────────────

  _focus(name) {
    if (!name) {
      this.ui.print(logger.warn('Usage: /focus <nickname>'));
      return;
    }
    const peer = this._resolvePeer(name);
    if (!peer) return;

    this._focusTarget = peer;
    this.ui.setPrompt(`@${peer.nickname}#${peer.discriminator}> `);
    this.ui.print(logger.system(`Focused on ${this._tag(peer)}. Type /back to return.`));
  }

  // ── /back ────────────────────────────────────────────────────────────────────

  _back() {
    if (!this._focusTarget) {
      this.ui.print(logger.warn('Not in focus mode.'));
      return;
    }
    this._cancelStopTyping();
    this._sendStopTyping(); // clear the peer's typing indicator immediately
    this.ui.print(logger.system(`Left conversation with ${this._tag(this._focusTarget)}.`));
    this._focusTarget = null;
    this.ui.setPrompt('> ');
  }

  // ── /notify ──────────────────────────────────────────────────────────────────

  _toggleNotify() {
    this._notifyState.enabled = !this._notifyState.enabled;
    const status = this._notifyState.enabled ? '\x1b[32mon\x1b[0m' : '\x1b[2moff\x1b[0m';
    this.ui.print(logger.system(`Desktop notifications ${status}.`));
  }

  // ── /clear ───────────────────────────────────────────────────────────────────

  _clear() {
    // clear() erases the screen and does a full readline redraw internally,
    // which works correctly in both normal and focus mode.
    this.ui.clear();
  }

  // ── /share ───────────────────────────────────────────────────────────────────

  async _share(args) {
    if (!args) {
      this.ui.print(logger.warn('Usage: /share <name> <filepath>  or  /share all <filepath>'));
      return;
    }
    if (!this.fileManager) return;

    // Broadcast: /share all <filepath>
    if (args.startsWith('all ') || args === 'all') {
      const rawPath = args.slice(4).trim();
      if (!rawPath) { this.ui.print(logger.warn('Usage: /share all <filepath>')); return; }
      const peers = this.peerStore.list();
      if (peers.length === 0) { this.ui.print(logger.warn('No peers online.')); return; }
      await this.fileManager.offerAll(peers, parseFilePath(rawPath));
      return;
    }

    // Direct: /share <name> <filepath>  OR  /share <filepath>  (in focus mode)
    const spaceIdx = args.indexOf(' ');

    let peer, rawPath;

    if (spaceIdx === -1) {
      // Single token — only valid in focus mode (the token is a path)
      if (!this._focusTarget) {
        this.ui.print(logger.warn('Usage: /share <name> <filepath>'));
        return;
      }
      peer    = this._focusTarget;
      rawPath = args;
    } else {
      const targetName = args.slice(0, spaceIdx);
      rawPath          = args.slice(spaceIdx + 1).trim();

      // In focus mode with a path that starts with / or ~ — treat whole arg as path
      if (this._focusTarget && (targetName.startsWith('/') || targetName.startsWith('~') || targetName.startsWith('"') || targetName.startsWith("'"))) {
        peer    = this._focusTarget;
        rawPath = args;
      } else {
        peer = this._resolvePeer(targetName);
        if (!peer) return;
      }
    }

    await this.fileManager.offerFile(peer, parseFilePath(rawPath));
  }

  // ── /accept ──────────────────────────────────────────────────────────────────

  async _accept(args) {
    if (!this.fileManager) return;
    await this.fileManager.acceptOffer(args || undefined);
  }

  // ── /reject ──────────────────────────────────────────────────────────────────

  _reject(args) {
    if (!this.fileManager) return;
    this.fileManager.rejectOffer(args || undefined);
  }

  // ── /cancel ──────────────────────────────────────────────────────────────────

  _cancel(args) {
    if (!this.fileManager) return;
    this.fileManager.cancel(args || undefined);
  }

  // ── /pause ───────────────────────────────────────────────────────────────────

  _pause(args) {
    if (!this.fileManager) return;
    this.fileManager.pause(args || undefined);
  }

  // ── /resume ──────────────────────────────────────────────────────────────────

  async _resume(args) {
    if (!this.fileManager) return;
    await this.fileManager.resume(args || undefined);
  }

  // ── /transfers ───────────────────────────────────────────────────────────────

  _transfers() {
    if (!this.fileManager) { this.ui.print('No active transfers.'); return; }
    this.ui.print(this.fileManager.listTransfers());
  }

  // ── /downloads ───────────────────────────────────────────────────────────────

  async _downloads(args) {
    if (!this.fileManager) return;
    if (!args) {
      this.ui.print(logger.system(`Downloads directory: ${this.fileManager._downloadsDir}`));
      return;
    }
    const resolved = parseFilePath(args);
    const fs = require('fs');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      this.ui.print(logger.error(`Directory not found: ${resolved}`));
      return;
    }
    this.fileManager.setDownloadsDir(resolved);
    this.ui.print(logger.system(`Downloads directory set to: ${resolved}`));
    if (this._onDownloadsDirChange) await this._onDownloadsDirChange(resolved);
  }

  // ── /call ────────────────────────────────────────────────────────────────────

  async _call(name) {
    if (!name) {
      this.ui.print(logger.warn('Usage: /call <nickname>'));
      return;
    }
    if (!this.callManager) return;
    const peer = this._resolvePeer(name);
    if (!peer) return;
    await this.callManager.placeCall(peer);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  // Colorised nickname with dim discriminator suffix
  _tag(peer) {
    return `${logger.colorize(peer.nickname)}${logger.dim('#' + peer.discriminator)}`;
  }

  _resolvePeer(input) {
    const { peer, ambiguous } = this.peerStore.findByNickname(input);
    if (!peer) {
      this.ui.print(logger.error(`Peer "${input}" not found. Use /list to see available devices.`));
      return null;
    }
    if (ambiguous) {
      const matches = this.peerStore.list().filter(p => p.nickname === input);
      const hints   = matches.map(p => `${p.nickname}#${p.discriminator}`).join(', ');
      this.ui.print(logger.warn(`Multiple peers named "${input}". Use the discriminator: ${hints}`));
      return null;
    }
    return peer;
  }

  async _sendTo(peer, text) {
    if (!text.trim()) return;
    try {
      await sendMessage(peer.ip, peer.port, {
        type:    'MESSAGE',
        from:    { id: this.deviceId, nickname: this.nickname, discriminator: this.discriminator },
        message: text,
      }, undefined, peer.fingerprint);
      this.history.addOutgoing(peer.id, peer.nickname, peer.discriminator, text);
      this.ui.printSent(
        `${logger.timestamp()} ${logger.colorize('You')} → ${this._tag(peer)}: ${text}`
      );
    } catch (e) {
      this.ui.print(logger.error(`Failed to reach ${this._tag(peer)}: ${e.message}`));
    }
  }

  // Fire a TYPING packet to the focused peer — debounced to once per 2 seconds.
  // Also resets a 3-second idle timer; when it fires, STOP_TYPING is sent.
  _sendTypingIndicator() {
    if (!this._focusTarget) return;

    // Reset the stop-typing idle timer on every keypress
    if (this._stopTypingTimer) clearTimeout(this._stopTypingTimer);
    this._stopTypingTimer = setTimeout(() => {
      this._stopTypingTimer = null;
      this._sendStopTyping();
    }, 3000);

    const now = Date.now();
    if (now - this._lastTypingSent < 2000) return;
    this._lastTypingSent = now;
    sendMessage(this._focusTarget.ip, this._focusTarget.port, {
      type: 'TYPING',
      from: { id: this.deviceId, nickname: this.nickname, discriminator: this.discriminator },
    }, 1000, this._focusTarget.fingerprint).catch(() => {});
  }

  _sendStopTyping() {
    if (!this._focusTarget) return;
    sendMessage(this._focusTarget.ip, this._focusTarget.port, {
      type: 'STOP_TYPING',
      from: { id: this.deviceId, nickname: this.nickname, discriminator: this.discriminator },
    }, 1000, this._focusTarget.fingerprint).catch(() => {});
  }

  _cancelStopTyping() {
    if (this._stopTypingTimer) {
      clearTimeout(this._stopTypingTimer);
      this._stopTypingTimer = null;
    }
  }
}

module.exports = Commands;
