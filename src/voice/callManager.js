'use strict';

const crypto = require('crypto');

const { sendMessage }     = require('../messaging/tcpClient');
const { generateOfferId } = require('../utils/fileUtils');
const MediaSocket         = require('./mediaSocket');
const EchoCanceller       = require('./echoCanceller');
const { MicSource, Speaker, isAudioAvailable, audioUnavailableReason } = require('./audioEngine');
const logger = require('../utils/logger');

const RING_TIMEOUT_MS     = 30_000;  // caller waits this long for an answer, then gives up
const RING_BELL_MS        = 3_000;   // callee terminal-bell repeat while ringing
const CALL_STATUS_MS      = 1_000;   // in-call status-line refresh (the running timer)
const MEDIA_FLOW_MS       = 1_500;   // remote audio considered "flowing" if a frame arrived this recently
const NO_AUDIO_HINT_MS    = 5_000;   // if no audio arrives within this long, hint at a firewall

// Format a millisecond duration as MM:SS (or H:MM:SS past an hour).
function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Manages voice calls. Phase 1 is signaling-only: it drives the full
// offer → ring → answer/reject → end handshake over the existing TLS control
// channel (CALL_* messages, dispatched by TCPServer) but does not yet move
// audio. The WebRTC media engine (wrtc + naudiodon2) is wired into the
// 'connecting' → 'in-call' transition in a later phase.
//
// Mirrors FileTransferManager: same constructor signature, the same
// sendMessage(...peer.fingerprint) control-message convention, the same
// _tag/peerLeft/cancelAll/onX(msg) shape, and the same logger/ui idioms.
//
// Only one call exists at a time (this._call). A second incoming offer while
// busy is answered with CALL_BUSY, exactly as a second file transfer is refused.
class CallManager {
  // opts (optional, for testability / alternate audio backends):
  //   createMediaSocket(key, direction) → MediaSocket-like      (default: real UDP+AES socket)
  //   createSource(role)                → EventEmitter 'frame' source (default: naudiodon mic)
  //   createSink()                      → { start, play(seq,samples), stop } (default: naudiodon speaker)
  //   audioAvailable()                  → bool                  (default: real device probe)
  constructor(peerStore, myId, myNick, myDisc, ui, cert, key, myFingerprint, opts = {}) {
    this._peerStore   = peerStore;
    this._myId        = myId;
    this._myNick      = myNick;
    this._myDisc      = myDisc;
    this._ui          = ui;
    this._cert        = cert;          // (TLS creds — currently unused by the UDP media path)
    this._key         = key;           // (TLS creds — currently unused by the UDP media path)
    this._fingerprint = myFingerprint; // (TLS creds — currently unused by the UDP media path)

    this._createMediaSocket = opts.createMediaSocket || ((k, dir) => new MediaSocket(k, dir));
    this._createSource      = opts.createSource      || (() => new MicSource());
    this._createSink        = opts.createSink        || (() => new Speaker());
    this._audioAvailable    = opts.audioAvailable    || isAudioAvailable;

    // Acoustic echo cancellation — on by default so calls work without headphones.
    // opts.echo === false (or /echo) disables it.
    this._echoEnabled = opts.echo !== false;

    // null when idle, otherwise the object returned by _newCallState().
    this._call = null;
  }

  // The full call-state shape, in one place. media is the MediaSocket (already
  // bound). offerMediaPort/offerKey are filled on the callee from CALL_OFFER.
  _newCallState({ callId, peer, role, status, media = null, offerMediaPort = null, offerKey = null }) {
    return {
      callId, peer, role, status,
      media,
      offerMediaPort,        // callee: the caller's UDP media port
      offerKey,              // callee: the shared key (Buffer) from the offer
      source:      null,     // microphone source feeding the send path
      sink:        null,     // speaker sink for the receive path
      aec:         null,     // echo canceller (null when disabled)
      lastRef:     null,     // most recent speaker frame — the AEC reference
      muted:       false,    // when true, the mic frames are not sent
      startedAt:   null,     // Date.now() when the call connected
      framesIn:    0,        // remote audio frames decrypted so far
      lastFrameAt: 0,        // Date.now() of the most recent remote frame
      ringTimer:   null,     // answer-timeout (caller) / missed-call timer (callee)
      bellTimer:   null,     // repeating terminal bell while ringing (callee)
      statusTimer: null,     // 1 s in-call status-line refresh
      noAudioTimer: null,    // fires a firewall hint if no audio arrives
    };
  }

  // ── Outgoing — place a call ────────────────────────────────────────────────

  async placeCall(peer) {
    if (this._call) {
      this._ui.print(logger.warn('You are already in a call. /hangup first.'));
      return;
    }
    if (!this._ensureAudio()) return;

    const callId  = generateOfferId();
    const mediaKey = crypto.randomBytes(32);            // shared AES-256 key for this call
    const media    = this._createMediaSocket(mediaKey, 0); // caller = direction 0

    let mediaPort;
    try {
      mediaPort = await media.bind();
    } catch (e) {
      this._ui.print(logger.error(`Could not open media port: ${e.message}`));
      media.close();
      return;
    }

    this._call = this._newCallState({ callId, peer, role: 'caller', status: 'calling', media });

    try {
      await sendMessage(peer.ip, peer.port, {
        type:   'CALL_OFFER',
        callId,
        from:   { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
        mediaPort,                       // caller's UDP media port
        key:    mediaKey.toString('hex'),// shared key, sent over the TLS-encrypted control channel
      }, undefined, peer.fingerprint);
    } catch (e) {
      this._ui.print(logger.error(`Could not reach ${this._tag(peer)}: ${e.message}`));
      this._clearCall();
      return;
    }

    this._ui.showProgress([`📞 Calling ${this._tag(peer)}… ringing`]);

    this._call.ringTimer = setTimeout(() => {
      if (this._call && this._call.callId === callId && this._call.status === 'calling') {
        this._ui.print(logger.warn(`${this._tag(peer)} did not answer.`));
        this._sendControl(peer, 'CALL_END', callId); // tell the callee to stop ringing
        this._clearCall();
      }
    }, RING_TIMEOUT_MS);
  }

  // ── Callee — answer / reject the ringing call ──────────────────────────────

  async answer() {
    if (!this._call || this._call.role !== 'callee' || this._call.status !== 'ringing') {
      this._ui.print(logger.warn('No incoming call to answer.'));
      return;
    }
    const { peer, callId, offerKey, offerMediaPort } = this._call;

    if (!offerKey || !offerMediaPort) {
      this._ui.print(logger.error(`${this._tag(peer)} did not offer a media channel — cannot connect.`));
      this._sendControl(peer, 'CALL_REJECT', callId);
      this._clearCall();
      return;
    }
    if (!this._ensureAudio()) {
      this._sendControl(peer, 'CALL_REJECT', callId);
      this._clearCall();
      return;
    }

    const media = this._createMediaSocket(offerKey, 1); // callee = direction 1
    let mediaPort;
    try {
      mediaPort = await media.bind();
    } catch (e) {
      this._ui.print(logger.error(`Could not open media port: ${e.message}`));
      media.close();
      this._sendControl(peer, 'CALL_END', callId);
      this._clearCall();
      return;
    }
    if (!this._call || this._call.callId !== callId) { media.close(); return; } // cancelled while binding

    media.setRemote(peer.ip, offerMediaPort);
    this._call.media = media;

    sendMessage(peer.ip, peer.port, {
      type:   'CALL_ACCEPT',
      callId,
      from:   { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
      mediaPort,                         // callee's UDP media port
    }, undefined, peer.fingerprint).catch(() => {});

    this._connect();
  }

  reject() {
    if (!this._call || this._call.role !== 'callee' || this._call.status !== 'ringing') {
      this._ui.print(logger.warn('No incoming call to reject.'));
      return;
    }
    const { peer, callId } = this._call;
    this._sendControl(peer, 'CALL_REJECT', callId);
    this._ui.print(logger.system(`Declined call from ${this._tag(peer)}.`));
    this._clearCall();
  }

  // ── Either side — mute toggle ──────────────────────────────────────────────

  toggleMute() {
    if (!this._call || this._call.status !== 'in-call') {
      this._ui.print(logger.warn('Not in a call.'));
      return;
    }
    this._call.muted = !this._call.muted;
    this._ui.print(logger.system(this._call.muted
      ? `Microphone muted. /mute to unmute.`
      : `Microphone unmuted.`));
    this._renderStatus();
  }

  // ── Echo cancellation toggle ───────────────────────────────────────────────

  toggleEcho() {
    this._echoEnabled = !this._echoEnabled;
    this._ui.print(logger.system(this._echoEnabled
      ? `Echo cancellation on. Recommended when not using headphones.`
      : `Echo cancellation off. Use headphones to avoid echo.`));
    // Apply immediately if a call is active.
    if (this._call && this._call.status === 'in-call') {
      this._call.aec = this._echoEnabled ? new EchoCanceller() : null;
    }
  }

  // ── Either side — hang up ──────────────────────────────────────────────────

  hangup() {
    if (!this._call) {
      this._ui.print(logger.warn('No active call.'));
      return;
    }
    const { peer, callId, status, startedAt } = this._call;
    this._sendControl(peer, 'CALL_END', callId);
    if (status === 'in-call') {
      const dur = formatDuration(Date.now() - startedAt);
      this._ui.print(logger.system(`Call with ${this._tag(peer)} ended — ${dur}.`));
    } else {
      this._ui.print(logger.system(`Call to ${this._tag(peer)} cancelled.`));
    }
    this._clearCall();
  }

  // ── TCPServer callbacks ────────────────────────────────────────────────────

  onCallOffer(msg) {
    const { callId, from } = msg;
    if (!callId || !from) return;

    // Already busy — refuse with CALL_BUSY (mirrors the single-transfer guard).
    if (this._call) {
      const peerEntry = this._peerStore.get(from.id);
      if (peerEntry) this._sendControl({ ...from, ...peerEntry }, 'CALL_BUSY', callId);
      // Glare: we are dialing the very peer who is dialing us. Both offers cross
      // and both get BUSY, so neither connects — tell the user how to recover.
      if (this._call.role === 'caller' && this._call.status === 'calling' && this._call.peer.id === from.id) {
        this._ui.print(logger.warn(
          `You and ${this._tag(this._call.peer)} are calling each other — one of you /hangup, then the other /call again.`
        ));
      }
      return;
    }

    // Enrich `from` with IP/port/fingerprint from peerStore for outgoing control messages.
    const peerEntry = this._peerStore.get(from.id);
    const caller    = peerEntry
      ? { ...from, ip: peerEntry.ip, port: peerEntry.port, fingerprint: peerEntry.fingerprint }
      : from;

    this._call = this._newCallState({
      callId, peer: caller, role: 'callee', status: 'ringing',
      offerMediaPort: msg.mediaPort,
      offerKey:       msg.key ? Buffer.from(msg.key, 'hex') : null,
    });

    process.stdout.write('\x07'); // terminal bell
    this._ui.print(
      `${logger.timestamp()} 📞 Incoming call from ${this._tag(caller)}.` +
      `  \x1b[36m/answer\x1b[0m  or  \x1b[36m/reject\x1b[0m`
    );

    // Keep bringing attention to the ringing call until it is answered/expires.
    this._call.bellTimer = setInterval(() => process.stdout.write('\x07'), RING_BELL_MS);

    this._call.ringTimer = setTimeout(() => {
      if (this._call && this._call.callId === callId && this._call.status === 'ringing') {
        this._ui.print(logger.warn(`Missed call from ${this._tag(caller)}.`));
        this._clearCall();
      }
    }, RING_TIMEOUT_MS);
  }

  onCallAccept(msg) {
    if (!this._call || this._call.role !== 'caller' || this._call.status !== 'calling') return;
    if (this._call.callId !== msg.callId) return;
    if (!msg.mediaPort) {
      this._ui.print(logger.error(`${this._tag(this._call.peer)} accepted without a media port — cannot connect.`));
      this.hangup();
      return;
    }
    this._call.media.setRemote(this._call.peer.ip, msg.mediaPort);
    this._connect();
  }

  onCallReject(msg) {
    if (!this._call || this._call.role !== 'caller') return;
    if (this._call.callId !== msg.callId) return;
    this._ui.print(logger.warn(`${this._tag(this._call.peer)} declined the call.`));
    this._clearCall();
  }

  onCallBusy(msg) {
    if (!this._call || this._call.role !== 'caller') return;
    if (this._call.callId !== msg.callId) return;
    this._ui.print(logger.warn(`${this._tag(this._call.peer)} is on another call.`));
    this._clearCall();
  }

  onCallEnd(msg) {
    if (!this._call) return;
    if (this._call.callId !== msg.callId) return;
    const { peer, status, startedAt } = this._call;
    if (status === 'in-call') {
      const dur = formatDuration(Date.now() - startedAt);
      this._ui.print(logger.system(`${this._tag(peer)} ended the call — ${dur}.`));
    } else {
      this._ui.print(logger.system(`${this._tag(peer)} cancelled the call.`));
    }
    this._clearCall();
  }

  // True while an incoming call is ringing and unanswered. Used by commands.js
  // so a ringing call takes priority over a pending file offer for /reject.
  hasIncomingCall() {
    return !!(this._call && this._call.role === 'callee' && this._call.status === 'ringing');
  }

  // ── Lifecycle (called from index.js) ───────────────────────────────────────

  peerLeft(peer) {
    if (this._call && this._call.peer.id === peer.id) {
      this._ui.print(logger.warn(`${peer.nickname} went offline — call ended.`));
      this._clearCall();
    }
  }

  cancelAll() {
    if (this._call) {
      this._sendControl(this._call.peer, 'CALL_END', this._call.callId);
      this._clearCall();
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  // Transition into the connected call. In Phase 1 this immediately goes
  // in-call; Phase 2 inserts media negotiation (SDP/ICE) before this point.
  _connect() {
    const { peer, media } = this._call;
    if (this._call.bellTimer) { clearInterval(this._call.bellTimer); this._call.bellTimer = null; }
    if (this._call.ringTimer) { clearTimeout(this._call.ringTimer); this._call.ringTimer = null; }

    // Open the microphone (capture) and speaker (playback). A device failure here
    // ends the call cleanly rather than crashing.
    //
    // ORDER MATTERS: the input (mic) stream is opened BEFORE the output (speaker)
    // stream. On macOS/CoreAudio, opening a PortAudio input stream while an output
    // stream is already running deadlocks the native layer and freezes the whole
    // process (the event loop blocks — even Ctrl-C stops responding). Input-first
    // avoids the deadlock and is safe on Windows/Linux too. Do not reorder.
    let sink, source;
    try {
      source = this._createSource(this._call.role);
      source.start();
      sink = this._createSink();
      sink.start();
    } catch (e) {
      if (sink)   { try { sink.stop(); }   catch (_) {} }
      if (source) { try { source.stop(); } catch (_) {} }
      this._ui.print(logger.error(`Audio device unavailable: ${e.message}`));
      this._micPermissionHint();
      this.hangup();
      return;
    }
    this._call.sink   = sink;
    this._call.source = source;

    // Echo cancellation: the speaker's played frames are the reference; the mic is
    // cleaned against them before being sent, so the far end never hears itself.
    this._call.aec     = this._echoEnabled ? new EchoCanceller() : null;
    this._call.lastRef = null;
    if (sink) sink.onPlay = (frame) => { if (this._call) this._call.lastRef = frame; };

    this._call.status    = 'in-call';
    this._call.startedAt = Date.now();
    this._ui.print(logger.system(`✔ Connected to ${this._tag(peer)}. /hangup to end.`));

    // A device error mid-call (unplugged headset, etc.) ends the call gracefully.
    if (sink) sink.onError = (e) => this._deviceError(e);
    source.on('error', (e) => this._deviceError(e));

    // Receive path: decrypted remote PCM frames → jitter buffer → speaker.
    media.on('frame', (samples, seq) => this._onRemoteFrame(samples, seq));

    // Send path: the microphone, echo-cancelled, drives outgoing frames (skipped
    // while muted).
    source.on('frame', (frame) => {
      if (!this._call || !this._call.media || this._call.muted) return;
      const out = this._call.aec ? this._call.aec.process(frame, this._call.lastRef) : frame;
      this._call.media.send(out);
    });

    this._renderStatus();
    this._call.statusTimer = setInterval(() => this._renderStatus(), CALL_STATUS_MS);

    // If no audio arrives at all, the most likely cause on a real network is a
    // firewall blocking the UDP media port — surface that as a diagnosis.
    this._call.noAudioTimer = setTimeout(() => {
      if (this._call && this._call.framesIn === 0) {
        this._ui.print(logger.warn(
          `No audio received from ${this._tag(this._call.peer)} yet. A firewall may be ` +
          `blocking the UDP media port — allow lnchat/node through the firewall on BOTH machines.`
        ));
      }
    }, NO_AUDIO_HINT_MS);
  }

  // A decrypted audio frame arrived from the peer: queue it for playout and tally it.
  _onRemoteFrame(samples, seq) {
    if (!this._call) return;
    const first = this._call.framesIn === 0;
    this._call.framesIn++;
    this._call.lastFrameAt = Date.now();
    if (this._call.sink) this._call.sink.play(seq, samples);
    if (first) {
      if (this._call.noAudioTimer) { clearTimeout(this._call.noAudioTimer); this._call.noAudioTimer = null; }
      this._ui.print(logger.system(`♪ Audio connected with ${this._tag(this._call.peer)}.`));
      this._renderStatus(); // surface the ♪ marker immediately, not on the next 1 s tick
    }
  }

  _deviceError(err) {
    if (!this._call) return;
    this._ui.print(logger.error(`Audio device error — ending call: ${err.message}`));
    this._micPermissionHint();
    this.hangup();
  }

  // Persistent in-call status line above the prompt — reuses the same progress
  // slot the file transfer feature uses (ui.showProgress/updateProgress).
  _renderStatus() {
    if (!this._call || this._call.status !== 'in-call') return;
    const dur     = formatDuration(Date.now() - this._call.startedAt);
    const flowing = Date.now() - this._call.lastFrameAt < MEDIA_FLOW_MS;
    const mark    = flowing ? ' ♪' : '';
    const muted   = this._call.muted ? logger.dim(' [muted]') : '';
    this._ui.updateProgress([`● In call with ${this._tag(this._call.peer)} — ${dur}${mark}${muted}`]);
  }

  _sendControl(peer, type, callId) {
    sendMessage(peer.ip, peer.port, {
      type,
      callId,
      from: { id: this._myId, nickname: this._myNick, discriminator: this._myDisc },
    }, undefined, peer.fingerprint).catch(() => {});
  }

  _clearCall() {
    if (!this._call) return;
    if (this._call.ringTimer)   clearTimeout(this._call.ringTimer);
    if (this._call.bellTimer)   clearInterval(this._call.bellTimer);
    if (this._call.statusTimer)  clearInterval(this._call.statusTimer);
    if (this._call.noAudioTimer) clearTimeout(this._call.noAudioTimer);
    if (this._call.source)       this._call.source.stop();
    if (this._call.sink)         this._call.sink.stop();
    if (this._call.media)        this._call.media.close();
    this._call = null;
    this._ui.clearProgress();
  }

  // Platform-specific guidance when the microphone/speaker can't be opened — most
  // often an OS permission gate rather than a real hardware fault.
  _micPermissionHint() {
    let hint;
    if (process.platform === 'darwin') {
      hint = 'Grant microphone access to your terminal in System Settings → Privacy & Security → Microphone, then try the call again.';
    } else if (process.platform === 'win32') {
      hint = 'Allow microphone access in Settings → Privacy → Microphone, and check no other app is using the device.';
    } else {
      hint = 'Check that your user can access the audio device (PulseAudio/PipeWire/ALSA) and that no other app holds it exclusively.';
    }
    this._ui.print(logger.dim(`  ${hint}`));
  }

  // Voice availability gate — prints a clear, non-fatal message when the native
  // audio engine can't load (unsupported platform, no prebuilt binary, etc.) so
  // chat and file transfer keep working everywhere.
  _ensureAudio() {
    if (this._audioAvailable()) return true;
    this._ui.print(logger.error('Voice calls are unavailable on this system — the audio engine could not be loaded.'));
    const why = audioUnavailableReason();
    if (why) this._ui.print(logger.dim(`  reason: ${why}`));
    this._ui.print(logger.dim('  Chat and file transfer are unaffected.'));
    return false;
  }

  // Colorised nickname with dim discriminator suffix (matches FileTransferManager).
  _tag(peer) {
    return `${logger.colorize(peer.nickname)}${logger.dim('#' + peer.discriminator)}`;
  }
}

module.exports = CallManager;
