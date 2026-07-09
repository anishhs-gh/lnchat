'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const PeerStore   = require('../src/peer/peerStore');
const TCPServer   = require('../src/messaging/tcpServer');
const CallManager = require('../src/voice/callManager');
const ToneSource  = require('../src/voice/toneSource');
const testCreds   = require('./testCreds');

// Use the tone source as a stand-in microphone and a no-op sink as the speaker,
// so this exercises the REAL encrypted UDP media path without touching audio
// hardware (keeps it headless / CI-safe).
class FakeSink { start() {} play() {} stop() {} }
const audioOpts = {
  createSource:   (role) => new ToneSource(role === 'caller' ? 440 : 480),
  createSink:     () => new FakeSink(),
  audioAvailable: () => true,
};

// Same UI stub as callManager.test.js.
function makeUI() {
  const prints = [];
  let progress = null;
  return {
    prints,
    print(m)            { prints.push(m); },
    printSent(m)        { prints.push(m); },
    showProgress(l)     { progress = l; },
    updateProgress(l)   { progress = l; },
    clearProgress()     { progress = null; },
    get progress()      { return progress; },
    all()               { return prints.join('\n'); },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Full node with the REAL media path (no fake injection) — exercises the actual
// encrypted UDP socket + tone source end to end.
async function makeNode(id, nick) {
  const store  = new PeerStore();
  const ui     = makeUI();
  const mgr    = new CallManager(store, id, nick, 'aa11', ui, testCreds.cert, testCreds.key, null, audioOpts);
  const server = new TCPServer(0, () => {}, testCreds);
  server.onCallOffer  = (m) => mgr.onCallOffer(m);
  server.onCallAccept = (m) => mgr.onCallAccept(m);
  server.onCallReject = (m) => mgr.onCallReject(m);
  server.onCallBusy   = (m) => mgr.onCallBusy(m);
  server.onCallEnd    = (m) => mgr.onCallEnd(m);
  const port = await server.start();
  return { id, nick, store, ui, mgr, server, port };
}

function introduce(a, b) {
  a.store.update(b.id, b.nick, 'aa11', '127.0.0.1', b.port, null);
}

describe('Voice integration (real encrypted media)', () => {
  let nodes = [];
  function track(...ns) { nodes.push(...ns); return ns; }
  afterEach(() => {
    for (const n of nodes) { n.mgr.cancelAll(); n.server.stop(); n.store.destroy(); }
    nodes = [];
  });

  test('encrypted tone flows in both directions once connected', async () => {
    const [a, b] = track(await makeNode('a', 'Alice'), await makeNode('b', 'Bob'));
    introduce(a, b); introduce(b, a);

    await a.mgr.placeCall(a.store.get('b'));
    await wait(80);
    await b.mgr.answer();

    // Let several 20 ms tone frames cross the wire each way.
    await wait(300);

    // Both managers decrypted real audio frames from the other end.
    assert.ok(a.mgr._call.framesIn > 0, 'caller received remote audio');
    assert.ok(b.mgr._call.framesIn > 0, 'callee received remote audio');
    assert.ok(a.ui.all().includes('Audio connected'));
    assert.ok(b.ui.all().includes('Audio connected'));

    // Status line shows the live audio marker.
    assert.ok(a.ui.progress && a.ui.progress[0].includes('♪'));

    // Bytes actually moved over UDP.
    assert.ok(a.mgr._call.media.bytesSent > 0);
    assert.ok(a.mgr._call.media.bytesRecv > 0);
  });

  test('mute stops outgoing audio; unmute resumes it', async () => {
    const [a, b] = track(await makeNode('a', 'Alice'), await makeNode('b', 'Bob'));
    introduce(a, b); introduce(b, a);

    await a.mgr.placeCall(a.store.get('b'));
    await wait(80);
    await b.mgr.answer();
    await wait(150);

    // Alice mutes; Bob should stop receiving new frames from her.
    a.mgr.toggleMute();
    assert.equal(a.mgr._call.muted, true);
    const bFramesAtMute = b.mgr._call.framesIn;
    await wait(200);
    assert.equal(b.mgr._call.framesIn, bFramesAtMute, 'no audio received while muted');

    // Unmute; frames flow again.
    a.mgr.toggleMute();
    await wait(200);
    assert.ok(b.mgr._call.framesIn > bFramesAtMute, 'audio resumes after unmute');
  });

  test('hangup tears down the media socket on both sides', async () => {
    const [a, b] = track(await makeNode('a', 'Alice'), await makeNode('b', 'Bob'));
    introduce(a, b); introduce(b, a);

    await a.mgr.placeCall(a.store.get('b'));
    await wait(80);
    await b.mgr.answer();
    await wait(120);

    a.mgr.hangup();
    await wait(80);

    assert.equal(a.mgr._call, null);
    assert.equal(b.mgr._call, null);  // Bob notified via CALL_END
    assert.ok(b.ui.all().includes('ended'));
  });
});
