'use strict';

const PeerStore   = require('./peer/peerStore');
const Broadcaster = require('./discovery/broadcaster');
const Listener    = require('./discovery/listener');
const TCPServer   = require('./messaging/tcpServer');
const Commands    = require('./cli/commands');
const UI          = require('./cli/ui');
const readline = require('readline');
const { resolveProfile, listProfiles, removeProfile, certFingerprint, factoryReset, saveProfile, loadProfile } = require('./utils/profile');
const { deriveSpaceToken } = require('./utils/space');
const FileTransferManager = require('./cli/fileTransferManager');
const CallManager         = require('./voice/callManager');
const KnownPeers     = require('./utils/knownPeers');
const MessageHistory = require('./utils/messageHistory');
const { getLocalIPs } = require('./utils/network');
const { notify }  = require('./utils/notify');
const logger      = require('./utils/logger');
const { checkNpmStatus, printBanner, printVersionStatus } = require('./utils/banner');
const currentVersion = require('./utils/version');

const PREFERRED_TCP_PORT = 9000;

function parseArgs(argv) {
  const args = argv.slice(2);
  let profileName  = 'default';
  let forceNew     = false;
  let listProfiles = false;
  let removeProfileName = null;
  let showVersion  = false;
  let doFactoryReset = false;
  let space        = '';
  let noNotify     = false;
  let port         = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' || args[i] === '-v') {
      showVersion = true;
    } else if (args[i] === '--profile' && args[i + 1]) {
      profileName = args[++i];
    } else if (args[i] === '--new-account') {
      forceNew = true;
    } else if (args[i] === '--list-profiles') {
      listProfiles = true;
    } else if (args[i] === '--remove-profile' && args[i + 1]) {
      removeProfileName = args[++i];
    } else if (args[i] === '--factory-reset') {
      doFactoryReset = true;
    } else if (args[i] === '--space' && args[i + 1]) {
      space = args[++i];
    } else if (args[i] === '--no-notify') {
      noNotify = true;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    }
  }
  return { profileName, forceNew, listProfiles, removeProfileName, showVersion, doFactoryReset, space, noNotify, port };
}

async function main() {
  const { profileName, forceNew, listProfiles: doList, removeProfileName, showVersion, doFactoryReset, space, noNotify, port } = parseArgs(process.argv);

  // ── Profile management commands (print and exit, no UI needed) ────────────
  if (showVersion) {
    await printVersionStatus(currentVersion);
    process.exit(0);
  }

  if (doList) {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log('No profiles found. Run without flags to create one.');
    } else {
      console.log('Profiles:\n');
      profiles.forEach(p => {
        const tag = `${p.nickname}#${p.discriminator}`;
        console.log(`  ${p.name.padEnd(16)} ${tag}`);
      });
      console.log('\nUse --profile <name> to select one.');
    }
    process.exit(0);
  }

  if (removeProfileName) {
    const removed = removeProfile(removeProfileName);
    if (removed) {
      console.log(`Profile "${removeProfileName}" removed.`);
    } else {
      console.error(`Profile "${removeProfileName}" not found.`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (doFactoryReset) {
    // Needs a fresh readline — the main UI hasn't been created yet.
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      '\x1b[33m⚠  Factory Reset\x1b[0m\n' +
      'This permanently deletes ALL profiles, keys, chat history, and stored data.\n' +
      'Type \x1b[1myes\x1b[0m to confirm: '
    );
    const answer = await new Promise((resolve) =>
      rl2.once('line', (l) => { rl2.close(); resolve(l.trim()); })
    );
    if (answer === 'yes') {
      const had = factoryReset();
      console.log(had
        ? '\x1b[32m✔\x1b[0m  Factory reset complete — all data removed.'
        : 'Nothing to reset — no lnchat data found.');
    } else {
      console.log('Cancelled.');
    }
    process.exit(0);
  }

  // Start the npm update check early — it runs in parallel with all startup
  // work (profile prompts, TCP bind, discovery) so by the time the banner
  // is printed the HTTP response is almost always already available.
  const updateCheck = checkNpmStatus(currentVersion);

  const ui = new UI();

  // ── Profile (nickname + persistent deviceId + discriminator) ──────────────
  const profile  = await resolveProfile(profileName, forceNew, ui);
  const { deviceId, nickname, discriminator, cert, key, signingKey } = profile;
  const fingerprint = certFingerprint(cert);

  // ── Space passphrase ──────────────────────────────────────────────────────
  // If --space was given, prompt for an optional passphrase (hidden, not saved).
  // The passphrase is used to derive an opaque token via PBKDF2; the token
  // replaces the plain space name in all HELLO packets so only peers with the
  // same name + passphrase can discover each other.  Empty passphrase = no
  // derivation, plain space name used (backward-compatible with v1.0.0).
  let spaceToken = space;
  if (space) {
    ui.printRaw(logger.info(`Space "${space}" may require a passphrase to reach other members.`));
    const passphrase = await ui.questionSecret(`  Passphrase (Enter to join without one): `);
    spaceToken = deriveSpaceToken(space, passphrase.trim());
  }

  // ── Peer store ────────────────────────────────────────────────────────────
  const peerStore = new PeerStore();
  let   commands; // declared here so onLeave can reference it once it's assigned

  const tag = (peer) => `${logger.colorize(peer.nickname)}${logger.dim('#' + peer.discriminator)}`;

  peerStore.onJoin  = (peer) => ui.print(logger.system(`${tag(peer)} joined the network`));
  peerStore.onLeave = (peer) => {
    ui.print(logger.system(`${tag(peer)} went offline`));
    if (commands) commands.peerLeft(peer);
  };

  // ── Message history ───────────────────────────────────────────────────────
  const history = new MessageHistory();

  // Shared notification toggle — read by the message handler, mutated by /notify
  // notifyFailed: flips to true after the first failed notify-send call so the
  // one-liner warning is shown at most once per session.
  const notifyState = { enabled: !noNotify, notifyFailed: false };

  // Per-peer typing state: peerId → setTimeout handle.
  // A key is present only while the peer is considered "currently typing".
  const typingState = new Map();

  // ── TCP server (receives messages and responds to pings) ──────────────────
  const tcpServer = new TCPServer(port || PREFERRED_TCP_PORT, (msg) => {
    // Arriving message ends the typing session for this peer.
    const timer = typingState.get(msg.from.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      typingState.delete(msg.from.id);
    }

    history.addIncoming(msg.from.id, msg.from, msg.message);
    process.stdout.write('\x07'); // terminal bell (audio / dock badge)
    if (notifyState.enabled) {
      const discPlain = msg.from.discriminator ? `#${msg.from.discriminator}` : '';
      notify(`lnchat — ${msg.from.nickname}${discPlain}`, msg.message, () => {
        if (!notifyState.notifyFailed) {
          notifyState.notifyFailed = true;
          ui.print(logger.warn('Desktop notifications are not available on this device.'));
        }
      });
    }
    const disc = msg.from.discriminator ? logger.dim('#' + msg.from.discriminator) : '';
    const line = `${logger.timestamp()} ${logger.colorize(msg.from.nickname)}${disc}\n  ${msg.message}`;
    const inFocus = commands && commands._focusTarget;
    const dimmed  = inFocus && commands._focusTarget.id !== msg.from.id;
    ui.print(dimmed ? logger.dimLine(line) : line);
  }, { cert, key });

  // Show indicator only once per typing session (idle → typing transition).
  // Each TYPING packet resets a 4-second idle timer; expiry returns to idle.
  tcpServer.onTyping = (from) => {
    const wasTyping = typingState.has(from.id);

    if (wasTyping) clearTimeout(typingState.get(from.id));
    typingState.set(from.id, setTimeout(() => typingState.delete(from.id), 4000));

    if (!wasTyping) {
      const disc = from.discriminator ? logger.dim('#' + from.discriminator) : '';
      ui.showTyping(`${logger.colorize(from.nickname)}${disc}`);
    }
  };

  // Peer explicitly stopped typing — erase the indicator immediately.
  tcpServer.onStopTyping = (from) => {
    const timer = typingState.get(from.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      typingState.delete(from.id);
    }
    ui.clearTyping();
  };

  let tcpPort;
  try {
    tcpPort = await tcpServer.start();
  } catch (e) {
    console.error('Fatal: could not start TCP server —', e.message);
    process.exit(1);
  }

  if (port && tcpPort !== port) {
    ui.printRaw(logger.warn(`Port ${port} is already in use — bound to ${tcpPort} instead.`));
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  const knownPeers  = new KnownPeers();
  const broadcaster = new Broadcaster(deviceId, nickname, discriminator, tcpPort, fingerprint, signingKey, spaceToken);
  const listener    = new Listener(deviceId, peerStore, knownPeers, spaceToken);

  listener.onConflict = (id, nick) => {
    ui.print(logger.system(
      `\x1b[33m⚠  Security warning:\x1b[0m ${nick} (${id.slice(0, 8)}…) sent a HELLO ` +
      `with a different public key — possible impersonation. Message rejected.`
    ));
  };

  broadcaster.start();
  await listener.start();

  // ── Startup banner ────────────────────────────────────────────────────────
  const localIPs = getLocalIPs();
  await printBanner(ui, currentVersion, updateCheck);
  ui.printRaw(logger.info(`Logged in as ${logger.colorize(nickname)}${logger.dim('#' + discriminator)}  (profile: ${profileName})`));
  ui.printRaw(logger.info('Connected to LAN'));
  if (space) ui.printRaw(logger.info(`Space            : ${space}`));
  ui.printRaw(logger.info(`Your IP${localIPs.length > 1 ? 's' : ''}: ${localIPs.join(', ') || '127.0.0.1 (loopback only)'}`));
  ui.printRaw(logger.info(`TCP messaging port : ${tcpPort}`));
  ui.printRaw(logger.info(`UDP discovery port : ${listener.boundPort}  (range 41234–41238)`));
  ui.printRaw('');
  ui.printRaw('Type /help for available commands.\n');

  // macOS: show the notification permission hint once, the first time lnchat runs.
  if (process.platform === 'darwin' && notifyState.enabled && !profile.notificationHintShown) {
    ui.printRaw(logger.dim('  Tip: grant notification permission in System Settings → Notifications → Terminal to enable desktop alerts.'));
    const saved = loadProfile(profileName) || {};
    saveProfile(profileName, { ...saved, notificationHintShown: true });
  }

  // ── File transfer manager ─────────────────────────────────────────────────
  const fileManager = new FileTransferManager(
    peerStore, deviceId, nickname, discriminator, ui, cert, key, fingerprint
  );

  // Load persisted download directory from profile (falls back to ~/Downloads inside the manager)
  if (profile.downloadsDir) fileManager.setDownloadsDir(profile.downloadsDir);

  // Wire all file-transfer control messages from TCPServer → FileTransferManager
  tcpServer.onFileOffer         = (msg) => fileManager.onFileOffer(msg);
  tcpServer.onFileAccept        = (msg) => fileManager.onFileAccept(msg);
  tcpServer.onFileReject        = (msg) => fileManager.onFileReject(msg);
  tcpServer.onFileReady         = (msg) => fileManager.onFileReady(msg);
  tcpServer.onFileCancel        = (msg) => fileManager.onFileCancel(msg);
  tcpServer.onFilePause         = (msg) => fileManager.onFilePause(msg);
  tcpServer.onFileResume        = (msg) => fileManager.onFileResume(msg);
  tcpServer.onFileResumeRequest = (msg) => fileManager.onFileResumeRequest(msg);

  // ── Call manager ──────────────────────────────────────────────────────────
  const callManager = new CallManager(
    peerStore, deviceId, nickname, discriminator, ui, cert, key, fingerprint
  );

  // Wire all call-signaling control messages from TCPServer → CallManager
  tcpServer.onCallOffer  = (msg) => callManager.onCallOffer(msg);
  tcpServer.onCallAccept = (msg) => callManager.onCallAccept(msg);
  tcpServer.onCallReject = (msg) => callManager.onCallReject(msg);
  tcpServer.onCallBusy   = (msg) => callManager.onCallBusy(msg);
  tcpServer.onCallEnd    = (msg) => callManager.onCallEnd(msg);

  // ── CLI input loop ────────────────────────────────────────────────────────
  commands = new Commands(peerStore, deviceId, nickname, discriminator, ui, history, notifyState);

  commands.fileManager = fileManager;
  commands.callManager = callManager;

  // Persist /downloads directory changes back to the profile JSON
  commands._onDownloadsDirChange = (newDir) => {
    const saved = loadProfile(profileName) || {};
    saveProfile(profileName, { ...saved, downloadsDir: newDir });
  };

  ui.showPrompt();

  ui.onLine(async (line) => {
    await commands.handle(line);
    // setPrompt() in focus/_back already redraws; showPrompt() covers normal mode
    if (!commands._focusTarget) ui.showPrompt();
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    fileManager.cancelAll();   // notify peers before discovery stops
    callManager.cancelAll();   // end any active call before discovery stops
    broadcaster.stop();
    listener.stop();
    tcpServer.stop();
    peerStore.destroy();
    // \r\x1b[2K — move to start of line and erase it (clears the prompt /
    // any partial input and the ^C echo the terminal may have added).
    process.stdout.write('\r\x1b[2K\x1b[2mQuitting…\x1b[0m\n');
    process.exit(0);
  }

  ui.onClose(shutdown);
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
