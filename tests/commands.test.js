'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const PeerStore      = require('../src/peer/peerStore');
const Commands       = require('../src/cli/commands');
const TCPServer      = require('../src/messaging/tcpServer');
const MessageHistory = require('../src/utils/messageHistory');
const testCreds      = require('./testCreds');

// Minimal UI stub — captures every print() call
function makeUI() {
  const prints = [];
  let prompt = '> ';
  return {
    prints,
    get currentPrompt() { return prompt; },
    print(msg)        { prints.push(msg); },
    printSent(msg)    { prints.push(msg); },
    showTyping()      {},
    clearTyping()     {},
    clear()           {},
    showPrompt()      {},
    setPrompt(str)    { prompt = str; },
    onKeypress()      {},
    last()            { return prints[prints.length - 1] ?? ''; },
    all()             { return prints.join('\n'); },
  };
}

describe('Commands', () => {
  let store, ui, cmds;

  function setup() {
    store = new PeerStore();
    ui    = makeUI();
    cmds  = new Commands(store, 'my-device', 'Me', 'ab12', ui, new MessageHistory(), { enabled: true });
  }

  afterEach(() => {
    store && store.destroy();
    if (cmds && cmds._stopTypingTimer) clearTimeout(cmds._stopTypingTimer);
  });

  // ── /list ─────────────────────────────────────────────────────────────────

  test('/list with no peers prints a "no peers" message', async () => {
    setup();
    await cmds.handle('/list');
    assert.ok(ui.last().includes('No peers'));
  });

  test('/list shows nickname and IP', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '10.0.0.1', 9000);
    await cmds.handle('/list');
    const out = ui.all();
    assert.ok(out.includes('Alice'));
    assert.ok(out.includes('10.0.0.1'));
  });

  test('/list shows discriminator', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '10.0.0.1', 9000);
    await cmds.handle('/list');
    assert.ok(ui.all().includes('#a1b2'));
  });

  test('/list shows latency when it has been recorded', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '10.0.0.1', 9000);
    store.updateLatency('abc', 12);
    await cmds.handle('/list');
    assert.ok(ui.all().includes('12ms'));
  });

  test('/list shows multiple peers', async () => {
    setup();
    store.update('a', 'Alice', 'a1b2', '10.0.0.1', 9000);
    store.update('b', 'Bob',   'c3d4', '10.0.0.2', 9001);
    await cmds.handle('/list');
    const out = ui.all();
    assert.ok(out.includes('Alice'));
    assert.ok(out.includes('Bob'));
  });

  // ── /msg ──────────────────────────────────────────────────────────────────

  test('/msg with no args shows usage hint', async () => {
    setup();
    await cmds.handle('/msg');
    assert.ok(ui.last().includes('Usage'));
  });

  test('/msg unknown peer shows error', async () => {
    setup();
    await cmds.handle('/msg Nobody hello');
    assert.ok(ui.last().includes('not found'));
  });

  test('/msg <name> without text enters pending mode', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/msg Alice');
    assert.ok(ui.last().includes('Alice'));
    assert.ok(cmds._pendingTarget !== null);
  });

  test('pending mode: next plain line is sent to the target', async () => {
    setup();
    // Spin up a real TCP server to receive the message
    const messages = [];
    const srv = new TCPServer(0, (m) => messages.push(m), testCreds);
    const port = await srv.start();

    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', port);
    await cmds.handle('/msg Alice');   // enter pending mode
    await cmds.handle('hello Alice'); // should be sent

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, 'hello Alice');
    srv.stop();
  });

  test('pending mode: command input cancels pending and executes the command', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/msg Alice'); // enter pending
    await cmds.handle('/list');      // command → should cancel pending and run /list
    assert.equal(cmds._pendingTarget, null);
    // /list output should have appeared
    assert.ok(ui.all().includes('Alice'));
  });

  test('/msg <name> <text> sends immediately (no pending)', async () => {
    setup();
    const messages = [];
    const srv = new TCPServer(0, (m) => messages.push(m), testCreds);
    const port = await srv.start();

    store.update('abc', 'Bob', 'c3d4', '127.0.0.1', port);
    await cmds.handle('/msg Bob hey there');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, 'hey there');
    assert.equal(cmds._pendingTarget, null);
    srv.stop();
  });

  test('/msg shows error when peer is unreachable', async () => {
    setup();
    store.update('abc', 'Ghost', 'dead', '127.0.0.1', 1); // port 1 → ECONNREFUSED
    await cmds.handle('/msg Ghost boo');
    assert.ok(ui.last().includes('Failed'));
  });

  test('/msg ambiguous name shows discriminator hint', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.update('def', 'Alice', 'c3d4', '127.0.0.2', 9001);
    await cmds.handle('/msg Alice hello');
    assert.ok(ui.last().includes('#'));
  });

  test('/msg name#disc routes to the correct peer', async () => {
    setup();
    const messages = [];
    const srv = new TCPServer(0, (m) => messages.push(m), testCreds);
    const port = await srv.start();

    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.update('def', 'Alice', 'c3d4', '127.0.0.1', port);
    await cmds.handle('/msg Alice#c3d4 hi');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, 'hi');
    srv.stop();
  });

  // ── /ping ─────────────────────────────────────────────────────────────────

  test('/ping with no name shows usage hint', async () => {
    setup();
    await cmds.handle('/ping');
    assert.ok(ui.last().includes('Usage'));
  });

  test('/ping unknown peer shows error', async () => {
    setup();
    await cmds.handle('/ping Nobody');
    assert.ok(ui.last().includes('not found'));
  });

  test('/ping reachable peer shows RTT and stores latency', async () => {
    setup();
    const srv = new TCPServer(0, () => {}, testCreds);
    const port = await srv.start();

    store.update('abc', 'Carol', 'e5f6', '127.0.0.1', port);
    await cmds.handle('/ping Carol');

    assert.ok(ui.last().includes('pong'));
    assert.ok(ui.last().includes('ms'));
    assert.ok(store.get('abc').latency != null);
    srv.stop();
  });

  test('/ping unreachable peer shows error', async () => {
    setup();
    store.update('abc', 'Ghost', 'dead', '127.0.0.1', 1);
    await cmds.handle('/ping Ghost');
    assert.ok(ui.last().includes('Ping failed'));
  });

  // ── /help ─────────────────────────────────────────────────────────────────

  test('/help lists all commands', async () => {
    setup();
    await cmds.handle('/help');
    const out = ui.last();
    assert.ok(out.includes('/list'));
    assert.ok(out.includes('/msg'));
    assert.ok(out.includes('/ping'));
    assert.ok(out.includes('/exit'));
  });

  // ── /clear ────────────────────────────────────────────────────────────────

  test('/clear calls ui.clear() and does not print anything', async () => {
    setup();
    let cleared = false;
    ui.clear = () => { cleared = true; };
    await cmds.handle('/clear');
    assert.ok(cleared, 'ui.clear() should have been called');
    assert.equal(ui.prints.length, 0, 'no messages should be printed');
  });

  test('/clear works while in focus mode without exiting it', async () => {
    setup();
    let cleared = false;
    ui.clear = () => { cleared = true; };
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/focus Alice');
    const printsBefore = ui.prints.length;
    await cmds.handle('/clear');
    assert.ok(cleared, 'ui.clear() should have been called');
    assert.ok(cmds._focusTarget !== null, 'focus mode should persist after /clear');
    assert.equal(ui.prints.length, printsBefore, 'no extra messages printed by /clear');
  });

  // ── /notify ───────────────────────────────────────────────────────────────

  test('/notify toggles notifications off then on', async () => {
    setup();
    assert.equal(cmds._notifyState.enabled, true, 'starts enabled');
    await cmds.handle('/notify');
    assert.equal(cmds._notifyState.enabled, false, 'disabled after first toggle');
    assert.ok(ui.last().includes('off'), 'prints "off" confirmation');
    await cmds.handle('/notify');
    assert.equal(cmds._notifyState.enabled, true, 're-enabled after second toggle');
    assert.ok(ui.last().includes('on'), 'prints "on" confirmation');
  });

  test('/notify respects initial --no-notify state', async () => {
    setup();
    cmds._notifyState.enabled = false; // simulate --no-notify
    await cmds.handle('/notify');
    assert.equal(cmds._notifyState.enabled, true, 'toggled on from disabled state');
  });

  // ── unknown input ─────────────────────────────────────────────────────────

  test('unknown slash command shows warning', async () => {
    setup();
    await cmds.handle('/foobar');
    assert.ok(ui.last().includes('Unknown command'));
  });

  test('plain text without pending shows help hint', async () => {
    setup();
    await cmds.handle('just chatting');
    assert.ok(ui.last().includes('/help'));
  });

  test('empty input is a no-op', async () => {
    setup();
    await cmds.handle('   ');
    assert.equal(ui.prints.length, 0);
  });

  // ── discriminators in output ───────────────────────────────────────────────

  test('sent message echo includes peer discriminator', async () => {
    setup();
    const srv = new TCPServer(0, () => {}, testCreds);
    const port = await srv.start();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', port);
    await cmds.handle('/msg Alice hi');
    assert.ok(ui.last().includes('#a1b2'));
    srv.stop();
  });

  test('pending mode prompt includes peer discriminator', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/msg Alice');
    assert.ok(ui.last().includes('#a1b2'));
  });

  test('pong message includes peer discriminator', async () => {
    setup();
    const srv = new TCPServer(0, () => {}, testCreds);
    const port = await srv.start();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', port);
    await cmds.handle('/ping Alice');
    assert.ok(ui.last().includes('#a1b2'));
    srv.stop();
  });

  // ── /focus and /back ──────────────────────────────────────────────────────

  test('/focus with no name shows usage hint', async () => {
    setup();
    await cmds.handle('/focus');
    assert.ok(ui.last().includes('Usage'));
  });

  test('/focus unknown peer shows error', async () => {
    setup();
    await cmds.handle('/focus Nobody');
    assert.ok(ui.last().includes('not found'));
  });

  test('/focus sets focusTarget and changes prompt', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/focus Alice');
    assert.ok(cmds._focusTarget !== null);
    assert.ok(ui.currentPrompt.includes('Alice'));
    assert.ok(ui.currentPrompt.includes('a1b2'));
  });

  test('plain text in focus mode sends to focused peer', async () => {
    setup();
    const messages = [];
    const srv = new TCPServer(0, (m) => messages.push(m), testCreds);
    const port = await srv.start();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', port);
    await cmds.handle('/focus Alice');
    await cmds.handle('hello focused');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, 'hello focused');
    assert.ok(cmds._focusTarget !== null, 'focus should persist after send');
    srv.stop();
  });

  test('/back exits focus mode and resets prompt', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/focus Alice');
    await cmds.handle('/back');
    assert.equal(cmds._focusTarget, null);
    assert.equal(ui.currentPrompt, '> ');
  });

  test('/back when not in focus mode shows warning', async () => {
    setup();
    await cmds.handle('/back');
    assert.ok(ui.last().includes('Not in focus'));
  });

  test('peerLeft auto-exits focus mode', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/focus Alice');
    const peer = store.get('abc');
    cmds.peerLeft(peer);
    assert.equal(cmds._focusTarget, null);
    assert.equal(ui.currentPrompt, '> ');
    assert.ok(ui.last().includes('offline'));
  });

  test('peerLeft for a non-focused peer does not clear focus', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    store.update('def', 'Bob',   'c3d4', '127.0.0.2', 9001);
    await cmds.handle('/focus Alice');
    cmds.peerLeft(store.get('def'));
    assert.ok(cmds._focusTarget !== null);
  });

  // ── /all ─────────────────────────────────────────────────────────────────

  test('/all with no text shows usage hint', async () => {
    setup();
    await cmds.handle('/all');
    assert.ok(ui.last().includes('Usage'));
  });

  test('/all with no peers shows no-peers message', async () => {
    setup();
    await cmds.handle('/all hello');
    assert.ok(ui.last().includes('No peers'));
  });

  test('/all sends to every online peer', async () => {
    setup();
    const msgs1 = [], msgs2 = [];
    const srv1 = new TCPServer(0, m => msgs1.push(m), testCreds);
    const srv2 = new TCPServer(0, m => msgs2.push(m), testCreds);
    const p1 = await srv1.start();
    const p2 = await srv2.start();

    store.update('a1', 'Alice', 'a1b2', '127.0.0.1', p1);
    store.update('b1', 'Bob',   'c3d4', '127.0.0.1', p2);
    await cmds.handle('/all hey everyone');

    await new Promise(r => setTimeout(r, 100));
    assert.equal(msgs1.length, 1);
    assert.equal(msgs2.length, 1);
    assert.equal(msgs1[0].message, 'hey everyone');
    srv1.stop(); srv2.stop();
  });

  // ── /history ─────────────────────────────────────────────────────────────

  test('/history with no messages shows empty message', async () => {
    setup();
    await cmds.handle('/history');
    assert.ok(ui.last().includes('No message history'));
  });

  test('/history shows recent messages across all peers', async () => {
    setup();
    cmds.history.addIncoming('p1', { nickname: 'Alice', discriminator: 'a1b2' }, 'hi there');
    cmds.history.addOutgoing('p1', 'Alice', 'a1b2', 'hey back');
    await cmds.handle('/history');
    const out = ui.last();
    assert.ok(out.includes('hi there'));
    assert.ok(out.includes('hey back'));
  });

  test('/history <name> filters to that peer', async () => {
    setup();
    cmds.history.addIncoming('p1', { nickname: 'Alice', discriminator: 'a1b2' }, 'from alice');
    cmds.history.addIncoming('p2', { nickname: 'Bob',   discriminator: 'c3d4' }, 'from bob');
    await cmds.handle('/history Alice');
    const out = ui.last();
    assert.ok(out.includes('from alice'));
    assert.ok(!out.includes('from bob'));
  });

  test('/history <name> with no history shows empty message', async () => {
    setup();
    await cmds.handle('/history Nobody');
    assert.ok(ui.last().includes('No history'));
  });

  // ── typing indicators ─────────────────────────────────────────────────────

  test('_sendTypingIndicator does nothing when not in focus mode', () => {
    setup();
    assert.doesNotThrow(() => cmds._sendTypingIndicator());
  });

  test('_sendTypingIndicator debounces within 2 seconds', () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    cmds._focusTarget = store.get('abc');
    cmds._lastTypingSent = Date.now(); // simulate recent send
    const before = cmds._lastTypingSent;
    cmds._sendTypingIndicator();
    assert.equal(cmds._lastTypingSent, before); // not updated (was debounced)
  });

  // ── focus mode (continued) ────────────────────────────────────────────────

  test('commands still work while in focus mode', async () => {
    setup();
    store.update('abc', 'Alice', 'a1b2', '127.0.0.1', 9000);
    await cmds.handle('/focus Alice');
    await cmds.handle('/list');
    assert.ok(ui.last().includes('Alice'));
    assert.ok(cmds._focusTarget !== null, 'focus survives a command');
  });
});
