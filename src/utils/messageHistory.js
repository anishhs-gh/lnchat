'use strict';

const MAX_PER_PEER = 50;

class MessageHistory {
  constructor() {
    // Map<peerId, Array<{ peerNickname, peerDisc, message, timestamp, outgoing }>>
    this._logs = new Map();
  }

  addIncoming(peerId, from, message) {
    this._push(peerId, {
      peerNickname: from.nickname,
      peerDisc:     from.discriminator || '????',
      message,
      timestamp: Date.now(),
      outgoing:  false,
    });
  }

  addOutgoing(peerId, peerNickname, peerDisc, message) {
    this._push(peerId, {
      peerNickname,
      peerDisc,
      message,
      timestamp: Date.now(),
      outgoing:  true,
    });
  }

  // Returns entries for a specific peer by ID
  getById(peerId) {
    return this._logs.get(peerId) || [];
  }

  // Returns entries for the first peer whose stored nickname matches
  getByNickname(nickname) {
    for (const entries of this._logs.values()) {
      if (entries.some(e => e.peerNickname === nickname)) {
        return entries.filter(e => e.peerNickname === nickname);
      }
    }
    return [];
  }

  // Returns the last n entries across all peers, sorted by time
  getRecent(n = 20) {
    const all = [];
    for (const entries of this._logs.values()) all.push(...entries);
    return all.sort((a, b) => a.timestamp - b.timestamp).slice(-n);
  }

  _push(peerId, entry) {
    if (!this._logs.has(peerId)) this._logs.set(peerId, []);
    const log = this._logs.get(peerId);
    log.push(entry);
    if (log.length > MAX_PER_PEER) log.shift();
  }
}

module.exports = MessageHistory;
