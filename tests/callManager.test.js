'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const PeerStore   = require('../src/peer/peerStore');
const TCPServer   = require('../src/messaging/tcpServer');
const CallManager = require('../src/voice/callManager');
const testCreds   = require('./testCreds');

// Stub media so the signaling tests stay pure and deterministic — no real UDP
// sockets or tone intervals. The real encrypted media path is covered by
// mediaSocket.test.js and voiceIntegration.test.js.
class FakeMediaSocket extends EventEmitter {
  async bind()    { return 40000 + Math.floor(Math.random() * 1000); }
  setRemote()     {}
  send()          {}
  close()         { this.removeAllListeners(); }
}
class FakeSource extends EventEmitter {
  start() {}
  stop()  {}
}
class FakeSink {
  start() {}
  play()  {}
  stop()  {}
}
const fakeMediaOpts = {
  createMediaSocket: () => new FakeMediaSocket(),
  createSource:      () => new FakeSource(),
  createSink:        () => new FakeSink(),
  audioAvailable:    () => true,
};

// UI stub capturing print() output and the progress-slot state the call status
// line writes to. Mirrors the makeUI() helper in commands.test.js.
function makeUI() {
  const prints = [];
  let progress = null;
  return {
    prints,
    print(msg)            { prints.push(msg); },
    printSent(msg)        { prints.push(msg); },
    showProgress(lines)   { progress = lines; },
    updateProgress(lines) { progress = lines; },
    clearProgress()       { progress = null; },
    get progress()        { return progress; },
    all()                 { return prints.join('\n'); },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Build one fully-wired node: peerStore + TLS TCPServer + CallManager, with the
// server's CALL_* hooks routed into the manager exactly as index.js wires them.
async function makeNode(id, nick) {
  const store = new PeerStore();
  const ui    = makeUI();
  const mgr   = new CallManager(store, id, nick, 'aa11', ui, testCreds.cert, testCreds.key, null, fakeMediaOpts);
  const server = new TCPServer(0, () => {}, testCreds);
  server.onCallOffer  = (m) => mgr.onCallOffer(m);
  server.onCallAccept = (m) => mgr.onCallAccept(m);
  server.onCallReject = (m) => mgr.onCallReject(m);
  server.onCallBusy   = (m) => mgr.onCallBusy(m);
  server.onCallEnd    = (m) => mgr.onCallEnd(m);
  const port = await server.start();
  return { id, nick, store, ui, mgr, server, port };
}

// Teach node `a` how to reach node `b` (peer entry with loopback IP + b's port).
function introduce(a, b) {
  a.store.update(b.id, b.nick, 'aa11', '127.0.0.1', b.port, null);
}

describe('CallManager signaling', () => {
  let nodes = [];

  function track(...ns) { nodes.push(...ns); return ns; }

  afterEach(() => {
    for (const n of nodes) {
      n.mgr.cancelAll();   // clears ring/bell/status timers so the test process can exit
      n.server.stop();
      n.store.destroy();
    }
    nodes = [];
  });

  test('offer → answer connects both sides', async () => {
    const [a, b] = track(await makeNode('a', 'Alice'), await makeNode('b', 'Bob'));
    introduce(a, b); introduce(b, a);

    await a.mgr.placeCall(a.store.get('b'));
    await wait(60);

    // Bob is ringing and was prompted to answer
    assert.ok(b.ui.all().includes('Incoming call'));
    assert.equal(b.mgr.hasIncomingCall(), true);

    b.mgr.answer();
    await wait(60);

    // Both sides report connected, both show the in-call status line
    assert.ok(a.ui.all().includes('Connected'));
    assert.ok(b.ui.all().includes('Connected'));
    assert.ok(a.ui.progress && a.ui.progress[0].includes('In call'));
    assert.ok(b.ui.progress && b.ui.progress[0].includes('In call'));
    assert.equal(b.mgr.hasIncomingCall(), false);
  });

  test('offer → reject declines the call', async () => {
    const [a, b] = track(await makeNode('a', 'Alice'), await makeNode('b', 'Bob'));
    introduce(a, b); introduce(b, a);

    await a.mgr.placeCall(a.store.get('b'));
    await wait(60);
    b.mgr.reject();
    await wait(60);

    assert.ok(a.ui.all().includes('declined'));
    assert.equal(a.ui.progress, null); // caller's "Calling…" line cleared
  });

  test('hangup ends an active call on both sides', async () => {
    const [a, b] = track(await makeNode('a', 'Alice'), await makeNode('b', 'Bob'));
    introduce(a, b); introduce(b, a);

    await a.mgr.placeCall(a.store.get('b'));
    await wait(60);
    b.mgr.answer();
    await wait(60);
    a.mgr.hangup();
    await wait(60);

    assert.ok(a.ui.all().includes('ended'));
    assert.ok(b.ui.all().includes('ended'));   // Bob notified via CALL_END
    assert.equal(a.ui.progress, null);
    assert.equal(b.ui.progress, null);
  });

  test('a second incoming call gets CALL_BUSY', async () => {
    const [a, b, c] = track(
      await makeNode('a', 'Alice'),
      await makeNode('b', 'Bob'),
      await makeNode('c', 'Carol'),
    );
    introduce(a, b); introduce(b, a);
    introduce(c, b); introduce(b, c);

    // A and B are in a call
    await a.mgr.placeCall(a.store.get('b'));
    await wait(60);
    b.mgr.answer();
    await wait(60);

    // Carol calls Bob while he's busy
    await c.mgr.placeCall(c.store.get('b'));
    await wait(60);

    assert.ok(c.ui.all().includes('another call'));
  });

  test('degrades gracefully when audio is unavailable (no crash, no call)', async () => {
    // Simulate a platform with no working native audio engine.
    const store = new PeerStore();
    const ui    = makeUI();
    const mgr   = new CallManager(store, 'a', 'Alice', 'aa11', ui, testCreds.cert, testCreds.key, null, {
      ...fakeMediaOpts,
      audioAvailable: () => false,
    });
    track({ mgr, server: { stop() {} }, store });

    store.update('b', 'Bob', 'bb22', '127.0.0.1', 9000, null);
    await mgr.placeCall(store.get('b'));

    assert.ok(ui.all().includes('unavailable'));
    assert.equal(mgr._call, null); // no call was started
  });

  test('placeCall is refused while already in a call', async () => {
    const [a, b] = track(await makeNode('a', 'Alice'), await makeNode('b', 'Bob'));
    introduce(a, b); introduce(b, a);

    await a.mgr.placeCall(a.store.get('b'));
    await wait(40);
    await a.mgr.placeCall(a.store.get('b')); // second attempt
    assert.ok(a.ui.all().includes('already in a call'));
  });
});
